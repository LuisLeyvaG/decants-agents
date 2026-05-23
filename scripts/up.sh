#!/usr/bin/env bash
# up.sh — levanta postgres + browserless (idempotente).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log_info() { printf '[info] %s\n' "$*"; }

log_info "Levantando containers (compose up -d)…"
bash "${REPO_ROOT}/scripts/compose-wrap.sh" up -d

log_info "Esperando 5s a que healthchecks empiecen a reportar…"
sleep 5

log_info "Estado actual:"
bash "${REPO_ROOT}/scripts/compose-wrap.sh" ps

log_info "Listo. Verifica con: bash scripts/healthcheck.sh"
