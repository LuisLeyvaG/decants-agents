#!/usr/bin/env bash
# compose-wrap.sh — invoca docker/compose:2 desde un container desechable.
#
# La VM corre Container-Optimized OS sin `docker compose` instalado. Este
# wrapper expone la CLI de compose montando el socket del daemon. El
# container de compose NO se mete en ninguna network: solo pasa órdenes
# al daemon, que orquesta postgres y browserless a leyvascents-net según
# el yml.
#
# Uso:
#   bash scripts/compose-wrap.sh up -d --build
#   bash scripts/compose-wrap.sh ps
#   bash scripts/compose-wrap.sh logs -f postgres

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env"
COMPOSE_FILE="${REPO_ROOT}/docker-compose.agents.yml"

log_error() { printf '[error] %s\n' "$*" >&2; }

if [[ ! -f "${ENV_FILE}" ]]; then
    log_error ".env no encontrado en ${REPO_ROOT}. Corre setup.sh primero."
    exit 1
fi

if [[ ! -f "${COMPOSE_FILE}" ]]; then
    log_error "docker-compose.agents.yml no encontrado en ${REPO_ROOT}."
    exit 1
fi

exec docker run --rm \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "${REPO_ROOT}":"${REPO_ROOT}" \
    -v "${ENV_FILE}":"${ENV_FILE}":ro \
    -w "${REPO_ROOT}" \
    --env-file "${ENV_FILE}" \
    docker/compose:2 \
    -f "${COMPOSE_FILE}" \
    "$@"
