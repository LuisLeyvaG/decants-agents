#!/usr/bin/env bash
# healthcheck.sh — verifica que postgres y browserless responden.
#
# Sale con código != 0 si algún check falla, para que se pueda usar en
# CI / cron / monitoring.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env"
readonly DOCKER_NETWORK="leyvascents-net"

log_info()  { printf '[info]  %s\n' "$*"; }
log_warn()  { printf '[warn]  %s\n' "$*" >&2; }
log_error() { printf '[error] %s\n' "$*" >&2; }

if [[ ! -f "${ENV_FILE}" ]]; then
    log_error ".env no encontrado. Corre setup.sh primero."
    exit 1
fi

# shellcheck disable=SC1090
set -a; source "${ENV_FILE}"; set +a

failed=0

# ----------------------------------------------------------------------
# 1. Postgres: container running + healthcheck OK + pg_isready
# ----------------------------------------------------------------------
log_info "Postgres: verificando container postgres-agents…"

pg_status="$(docker inspect -f '{{.State.Status}}' postgres-agents 2>/dev/null || echo "missing")"
if [[ "${pg_status}" != "running" ]]; then
    log_error "postgres-agents no está running (estado: ${pg_status})"
    failed=1
else
    pg_health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' postgres-agents)"
    log_info "postgres-agents status=${pg_status} health=${pg_health}"

    if [[ "${pg_health}" != "healthy" && "${pg_health}" != "none" ]]; then
        log_warn "Healthcheck reporta: ${pg_health} (aún arrancando?)"
        failed=1
    fi

    if docker exec postgres-agents pg_isready -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" >/dev/null 2>&1; then
        log_info "pg_isready: OK"
    else
        log_error "pg_isready falló"
        failed=1
    fi
fi

# ----------------------------------------------------------------------
# 2. Browserless: container running + endpoint /json/version responde
# ----------------------------------------------------------------------
log_info "Browserless: verificando container browserless…"

bl_status="$(docker inspect -f '{{.State.Status}}' browserless 2>/dev/null || echo "missing")"
if [[ "${bl_status}" != "running" ]]; then
    log_error "browserless no está running (estado: ${bl_status})"
    failed=1
else
    log_info "browserless status=${bl_status}"

    # curl efímero en la misma network. /json/version es endpoint estándar
    # de CDP (no requiere token en muchas configs, pero lo pasamos por si).
    if docker run --rm \
        --network "${DOCKER_NETWORK}" \
        curlimages/curl:latest \
        -fsS --max-time 10 \
        "http://browserless:3000/json/version?token=${BROWSERLESS_TOKEN}" \
        >/dev/null 2>&1; then
        log_info "browserless /json/version: OK"
    else
        log_error "browserless /json/version no respondió"
        failed=1
    fi
fi

# ----------------------------------------------------------------------
if [[ ${failed} -ne 0 ]]; then
    log_error "Healthcheck FAILED (al menos un check falló)."
    exit 1
fi

log_info "Healthcheck OK."
