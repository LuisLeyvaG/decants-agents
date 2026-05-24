#!/usr/bin/env bash
# setup.sh — corre UNA VEZ en la VM (idempotente).
#
# Responsabilidades:
#   1. Verifica prerequisitos en la VM (curl, python3, base64, openssl, docker).
#   2. Verifica que la network leyvascents-net existe.
#   3. Obtiene un access token del Service Account de la VM vía
#      metadata server, y verifica permisos contra Secret Manager.
#   4. Genera los 3 secretos nuevos en Secret Manager si no existen
#      (postgres password, browserless token, n8n webhook secret).
#   5. Lee TODOS los secretos requeridos y construye el .env raíz (mode 600).
#
# IMPORTANTE: Container-Optimized OS NO trae gcloud. Por eso este script
# habla directo con la REST API de Secret Manager usando el access token
# del Service Account de la VM (mismo patrón que decants-infrastructure/
# scripts/rotate-on-vm.sh).
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

readonly METADATA_TOKEN_URL="http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
readonly SM_BASE="https://secretmanager.googleapis.com/v1/projects/${GCP_PROJECT}/secrets"

# Se asigna en main() después de verificar prerequisitos.
ACCESS_TOKEN=""

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

# Pide un access token al metadata server. Retorna el token en stdout, o
# exit != 0 si el metadata server no responde (no estamos en una VM de GCP,
# o no hay SA asociado).
get_access_token() {
    curl -sf \
        -H "Metadata-Flavor: Google" \
        "${METADATA_TOKEN_URL}" \
        | python3 -c "import sys, json; print(json.load(sys.stdin)['access_token'])"
}

# Lee la versión 'latest' de un secret. stdout = valor en plano (sin
# trailing newline). Retorna != 0 si el secret no existe o no hay acceso.
read_secret() {
    local name="$1"
    curl -sf \
        -H "Authorization: Bearer ${ACCESS_TOKEN}" \
        "${SM_BASE}/${name}/versions/latest:access" \
        2>/dev/null \
        | python3 -c "import sys, json, base64; print(base64.b64decode(json.load(sys.stdin)['payload']['data']).decode(), end='')" 2>/dev/null
}

# True si el secret existe (independientemente de si tiene versiones).
# Hacemos un GET al recurso del secret (no a sus versiones) — si retorna
# 200, el secret ya está creado.
secret_exists() {
    local name="$1"
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' \
        -H "Authorization: Bearer ${ACCESS_TOKEN}" \
        "${SM_BASE}/${name}")"
    [[ "${code}" == "200" ]]
}

# Crea el secret (replication automática) y le agrega la primera versión.
# NO es idempotente por sí solo — ensure_secret() hace el guard.
create_secret() {
    local name="$1"
    local value="$2"

    # 1) Crear el contenedor del secret.
    curl -sf -X POST \
        -H "Authorization: Bearer ${ACCESS_TOKEN}" \
        -H "Content-Type: application/json" \
        -d '{"replication":{"automatic":{}}}' \
        "${SM_BASE}?secretId=${name}" \
        >/dev/null

    # 2) Agregar la primera versión (data en base64, single line).
    local data_b64
    data_b64="$(printf '%s' "${value}" | base64 -w 0)"
    curl -sf -X POST \
        -H "Authorization: Bearer ${ACCESS_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "{\"payload\":{\"data\":\"${data_b64}\"}}" \
        "${SM_BASE}/${name}:addVersion" \
        >/dev/null
}

# Crea el secret si no existe; si existe, no hace nada.
ensure_secret() {
    local name="$1"
    local value="$2"

    if secret_exists "${name}"; then
        log_info "Secret ya existe, sin tocar: ${name}"
        return 0
    fi

    log_info "Creando secret: ${name}"
    create_secret "${name}" "${value}"
}

main() {
    log_info "Verificando prerequisitos…"
    require_cmd docker
    require_cmd openssl
    require_cmd curl
    require_cmd python3
    require_cmd base64

    if ! docker network inspect "${DOCKER_NETWORK}" >/dev/null 2>&1; then
        log_error "Network Docker '${DOCKER_NETWORK}' no existe."
        log_error "Esta network la gestiona el stack de n8n. NO la crea este script."
        exit 1
    fi
    log_info "Network '${DOCKER_NETWORK}' OK."

    log_info "Postgres usará named volume gestionado por Docker."

    log_info "Obteniendo access token desde el metadata server…"
    # `|| true` evita que set -e aborte la substitución si get_access_token
    # falla (curl -sf + pipefail propagan exit != 0). Después chequeamos vacío.
    ACCESS_TOKEN="$(get_access_token 2>/dev/null || true)"
    readonly ACCESS_TOKEN
    if [[ -z "${ACCESS_TOKEN}" ]]; then
        log_error "No se pudo obtener access token desde metadata server."
        log_error "Este script debe correr DENTRO de la VM."
        log_error "Si ya estás en la VM, verifica que tiene un Service Account asignado:"
        log_error "  curl -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email"
        exit 1
    fi
    log_info "Access token obtenido."

    log_info "Verificando permisos vs Secret Manager (dry-test: leer ${SECRET_BD_ENDPOINT})…"
    if ! read_secret "${SECRET_BD_ENDPOINT}" >/dev/null 2>&1; then
        log_error "El SA de la VM no puede leer secrets, o el secret '${SECRET_BD_ENDPOINT}' no existe."
        log_error "Verifica IAM en project=${GCP_PROJECT}:"
        log_error "  - roles/secretmanager.secretAccessor (lectura de los secrets de Bright Data)"
        log_error "  - roles/secretmanager.admin (necesario para CREAR los 3 secretos nuevos)"
        log_error "  Ver TODO.md → 'Pre-requisitos de IAM' para el cambio en Terraform."
        exit 1
    fi
    log_info "Acceso a Secret Manager OK."

    log_info "Asegurando secretos en Secret Manager (project=${GCP_PROJECT})…"
    ensure_secret "${SECRET_PG_PASSWORD}"       "$(openssl rand -base64 64 | tr -d '\n/+=' | head -c 40)"
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
