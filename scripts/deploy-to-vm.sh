#!/usr/bin/env bash
# deploy-to-vm.sh — sube el repo a la VM desde la laptop.
#
# Detecta SO y elige transport:
#   * Linux/macOS con rsync → rsync sobre `gcloud compute ssh` (incremental).
#   * Cualquier otro caso (incluido Windows/Git-Bash) → tarball local + scp
#     de un solo archivo + extract remoto via SSH. Evita los bugs de pscp
#     con múltiples archivos y el de stdin-forwarding sobre el túnel IAP.
#
# NO sube .env (cada VM tiene el suyo, generado por setup.sh).
# NO sube .git ni node_modules ni logs.

set -euo pipefail

readonly GCP_PROJECT="leyva-scents"
readonly VM_NAME="leyvascents-n8n"
readonly VM_ZONE="us-central1-a"

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

# Detección de usuario remoto.
# El username en la VM no necesariamente coincide con $USER local: gcloud
# OS Login deriva el nombre del email (ej. leyva_garcia_luis_gerardo_gmail_).
# Si confiásemos en $USER local, el path /home/<user>/agents apuntaría
# al directorio equivocado (o inexistente) en la VM.
log_info "Detectando usuario remoto en la VM…"
REMOTE_USER="$(gcloud compute ssh "${VM_NAME}" \
    --project="${GCP_PROJECT}" \
    --zone="${VM_ZONE}" \
    --tunnel-through-iap \
    --command='whoami' 2>/dev/null | tr -d '\r\n')"

if [[ -z "${REMOTE_USER}" ]]; then
    log_error "No se pudo detectar el usuario remoto en la VM."
    log_error "Verifica acceso SSH con:"
    log_error "  gcloud compute ssh ${VM_NAME} --project=${GCP_PROJECT} --zone=${VM_ZONE} --tunnel-through-iap"
    exit 1
fi

log_info "Usuario remoto: ${REMOTE_USER}"
readonly REMOTE_USER
readonly VM_DEST_DIR="/home/${REMOTE_USER}/agents"

log_info "Asegurando directorio destino en VM: ${VM_DEST_DIR}"
gcloud compute ssh "${VM_NAME}" \
    --project="${GCP_PROJECT}" \
    --zone="${VM_ZONE}" \
    --tunnel-through-iap \
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
    log_info "Transport: tarball + scp single-file"
    log_info "Razón: stdin streaming no funciona bien en Git Bash sobre Windows."

    TAR_EXCLUDES=(
        --exclude='.git'
        --exclude='.env'
        --exclude='.env.local'
        --exclude='node_modules'
        --exclude='*.log'
        --exclude='.DS_Store'
    )

    # Tarball local con nombre único
    LOCAL_TAR="$(mktemp -u --suffix=.tar 2>/dev/null || true)"
    # Si mktemp -u no soporta --suffix en Git Bash, fallback:
    if [[ -z "${LOCAL_TAR}" || "${LOCAL_TAR}" == "-u" ]]; then
        LOCAL_TAR="/tmp/decants-agents-deploy-$$.tar"
    fi
    REMOTE_TAR="/tmp/decants-agents-deploy-$$.tar"

    trap 'rm -f "${LOCAL_TAR}"' EXIT

    log_info "Creando tarball local: ${LOCAL_TAR}"
    tar -cf "${LOCAL_TAR}" "${TAR_EXCLUDES[@]}" -C "${REPO_ROOT}" .
    log_info "Tamaño del tarball: $(du -h "${LOCAL_TAR}" | cut -f1)"

    log_info "Subiendo tarball a ${VM_NAME}:${REMOTE_TAR}…"
    gcloud compute scp \
        --project="${GCP_PROJECT}" \
        --zone="${VM_ZONE}" \
        --tunnel-through-iap \
        "${LOCAL_TAR}" \
        "${VM_NAME}:${REMOTE_TAR}"

    log_info "Extrayendo en VM y limpiando tarball remoto…"
    gcloud compute ssh "${VM_NAME}" \
        --project="${GCP_PROJECT}" \
        --zone="${VM_ZONE}" \
        --tunnel-through-iap \
        --command="cd '${VM_DEST_DIR}' && tar -xf '${REMOTE_TAR}' && rm -f '${REMOTE_TAR}' && echo '[remote] extract OK'"

    log_info "Tarball deploy completo."
fi

log_info "Deploy completo."
log_info ""
log_info "Próximos pasos en la VM (gcloud compute ssh ${VM_NAME} --project=${GCP_PROJECT} --zone=${VM_ZONE}):"
log_info "  cd ${VM_DEST_DIR}"
log_info "  bash scripts/setup.sh        # primera vez únicamente"
log_info "  bash scripts/up.sh"
log_info "  bash scripts/healthcheck.sh"
