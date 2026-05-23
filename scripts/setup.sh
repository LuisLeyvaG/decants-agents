#!/usr/bin/env bash
# setup.sh — corre UNA VEZ en la VM (idempotente).
#
# Responsabilidades:
#   1. Verifica prerequisitos (gcloud, docker, network leyvascents-net).
#   2. Genera los 3 secretos nuevos en Secret Manager si no existen
#      (postgres password, browserless token, n8n webhook secret).
#   3. Lee TODOS los secretos (los 3 nuevos + Bright Data + DB name fijo)
#      y construye el .env raíz con permisos 600.
#
# La data de Postgres vive en un named volume gestionado por Docker
# (postgres-agents-data) — no se administra desde este script.
#
# Re-correr es seguro: no regenera secretos existentes y no toca data.

set -euo pipefail

readonly GCP_PROJECT="leyva-scents"
readonly DOCKER_NETWORK="leyvascents-net"
readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ENV_FILE="${REPO_ROOT}/.env"

readonly SECRET_PG_PASSWORD="leyvascents-postgres-agents-password"
readonly SECRET_BROWSERLESS_TOKEN="leyvascents-browserless-token"
readonly SECRET_N8N_WEBHOOK="leyvascents-n8n-webhook-secret"
readonly SECRET_BD_ENDPOINT="leyvascents-brightdata-endpoint"
readonly SECRET_BD_USERNAME="leyvascents-brightdata-username"
readonly SECRET_BD_PASSWORD="leyvascents-brightdata-password"

log_info()  { printf '[info]  %s\n' "$*"; }
log_warn()  { printf '[warn]  %s\n' "$*" >&2; }
log_error() { printf '[error] %s\n' "$*" >&2; }

require_cmd() {
    local cmd="$1"
    if ! command -v "$cmd" >/dev/null 2>&1; then
        log_error "Comando requerido no encontrado: $cmd"
        exit 1
    fi
}

# True si el secreto ya existe en Secret Manager.
secret_exists() {
    local name="$1"
    gcloud secrets describe "$name" \
        --project="${GCP_PROJECT}" \
        >/dev/null 2>&1
}

# Crea un secreto desde stdin si no existe; si existe, no hace nada.
ensure_secret() {
    local name="$1"
    local value="$2"

    if secret_exists "$name"; then
        log_info "Secret ya existe, sin tocar: ${name}"
        return 0
    fi

    log_info "Creando secret: ${name}"
    printf '%s' "$value" | gcloud secrets create "$name" \
        --project="${GCP_PROJECT}" \
        --replication-policy="automatic" \
        --data-file=- \
        >/dev/null
}

# Lee la última versión de un secreto. Aborta si no existe.
read_secret() {
    local name="$1"
    gcloud secrets versions access latest \
        --secret="$name" \
        --project="${GCP_PROJECT}" 2>/dev/null
}

main() {
    log_info "Verificando prerequisitos…"
    require_cmd gcloud
    require_cmd docker
    require_cmd openssl

    if ! docker network inspect "${DOCKER_NETWORK}" >/dev/null 2>&1; then
        log_error "Network Docker '${DOCKER_NETWORK}' no existe."
        log_error "Esta network la gestiona el stack de n8n. NO la crea este script."
        exit 1
    fi
    log_info "Network '${DOCKER_NETWORK}' OK."

    log_info "Postgres usará named volume gestionado por Docker."

    log_info "Asegurando secretos en Secret Manager (project=${GCP_PROJECT})…"
    ensure_secret "${SECRET_PG_PASSWORD}"      "$(openssl rand -base64 64 | tr -d '\n/+=' | head -c 40)"
    ensure_secret "${SECRET_BROWSERLESS_TOKEN}" "$(openssl rand -hex 32)"
    ensure_secret "${SECRET_N8N_WEBHOOK}"       "$(openssl rand -hex 32)"

    log_info "Leyendo todos los secretos requeridos…"
    local pg_password browserless_token bd_endpoint bd_username bd_password
    pg_password="$(read_secret "${SECRET_PG_PASSWORD}")"
    browserless_token="$(read_secret "${SECRET_BROWSERLESS_TOKEN}")"
    bd_endpoint="$(read_secret "${SECRET_BD_ENDPOINT}")"
    bd_username="$(read_secret "${SECRET_BD_USERNAME}")"
    bd_password="$(read_secret "${SECRET_BD_PASSWORD}")"

    for var_name in pg_password browserless_token bd_endpoint bd_username bd_password; do
        if [[ -z "${!var_name:-}" ]]; then
            log_error "Secreto vacío o no legible: ${var_name}. Revisa Secret Manager y permisos."
            exit 1
        fi
    done

    local proxy_server="http://${bd_username}:${bd_password}@${bd_endpoint}"

    log_info "Escribiendo ${ENV_FILE} (mode 600)…"
    umask 077
    cat > "${ENV_FILE}" <<EOF
# Generado por scripts/setup.sh — NO commitear.
# Re-correr setup.sh sobrescribe este archivo con valores frescos del Secret Manager.

POSTGRES_USER=agents
POSTGRES_DB=agents
POSTGRES_PASSWORD=${pg_password}

BROWSERLESS_TOKEN=${browserless_token}
PROXY_SERVER=${proxy_server}
EOF
    chmod 600 "${ENV_FILE}"

    log_info "Setup completo."
    log_info "Próximo paso: bash scripts/up.sh"
}

main "$@"
