#!/usr/bin/env bash
# deploy-to-vm.sh — sube el repo a la VM desde la laptop.
#
# Detecta SO y elige transport:
#   * Linux/macOS con rsync → rsync sobre `gcloud compute ssh` (incremental).
#   * Cualquier otro caso (incluido Windows/Git-Bash) → gcloud compute scp --recurse.
#
# NO sube .env (cada VM tiene el suyo, generado por setup.sh).
# NO sube .git ni node_modules ni logs.

set -euo pipefail

readonly GCP_PROJECT="leyva-scents"
readonly VM_NAME="leyvascents-n8n"
readonly VM_ZONE="us-central1-a"
readonly VM_USER="${USER:-$(whoami)}"
readonly VM_DEST_DIR="/home/${VM_USER}/agents"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log_info()  { printf '[info]  %s\n' "$*"; }
log_warn()  { printf '[warn]  %s\n' "$*" >&2; }
log_error() { printf '[error] %s\n' "$*" >&2; }

require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        log_error "Comando requerido no encontrado: $1"
        exit 1
    fi
}

require_cmd gcloud

log_info "Asegurando directorio destino en VM: ${VM_DEST_DIR}"
gcloud compute ssh "${VM_NAME}" \
    --project="${GCP_PROJECT}" \
    --zone="${VM_ZONE}" \
    --command="mkdir -p '${VM_DEST_DIR}'" \
    >/dev/null

# Detección de transport.
use_rsync=0
if command -v rsync >/dev/null 2>&1; then
    case "$(uname -s)" in
        Linux*|Darwin*) use_rsync=1 ;;
    esac
fi

if [[ ${use_rsync} -eq 1 ]]; then
    log_info "Transport: rsync sobre gcloud SSH"
    rsync -avz --delete \
        --exclude '.git/' \
        --exclude '.env' \
        --exclude '.env.local' \
        --exclude 'node_modules/' \
        --exclude '*.log' \
        --exclude '.DS_Store' \
        -e "gcloud compute ssh ${VM_NAME} --project=${GCP_PROJECT} --zone=${VM_ZONE} --tunnel-through-iap --" \
        "${REPO_ROOT}/" \
        ":${VM_DEST_DIR}/"
else
    log_info "Transport: gcloud compute scp --recurse (sin incremental)"
    log_warn "rsync no disponible — todos los archivos se re-suben en cada deploy."

    # Lista lo que se sube, para que el usuario vea qué entra. Excluye
    # explícitamente .env / .git etc. usando un staging temporal.
    staging="$(mktemp -d)"
    trap 'rm -rf "${staging}"' EXIT

    log_info "Preparando staging en ${staging}…"

    # Copia respetando exclusiones. Usamos tar para no depender de rsync.
    tar -cf - \
        --exclude='.git' \
        --exclude='.env' \
        --exclude='.env.local' \
        --exclude='node_modules' \
        --exclude='*.log' \
        --exclude='.DS_Store' \
        -C "${REPO_ROOT}" . \
        | tar -xf - -C "${staging}"

    gcloud compute scp \
        --project="${GCP_PROJECT}" \
        --zone="${VM_ZONE}" \
        --recurse \
        "${staging}/." \
        "${VM_NAME}:${VM_DEST_DIR}/"
fi

log_info "Deploy completo."
log_info ""
log_info "Próximos pasos en la VM (gcloud compute ssh ${VM_NAME} --project=${GCP_PROJECT} --zone=${VM_ZONE}):"
log_info "  cd ${VM_DEST_DIR}"
log_info "  bash scripts/setup.sh        # primera vez únicamente"
log_info "  bash scripts/up.sh"
log_info "  bash scripts/healthcheck.sh"
