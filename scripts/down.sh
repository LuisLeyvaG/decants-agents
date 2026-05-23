#!/usr/bin/env bash
# down.sh — detiene postgres + browserless preservando volumes/data.
#
# Importante: NO usa `-v`. El named volume `postgres-agents-data` se
# conserva. Si necesitas reset destructivo, hazlo manualmente y a propósito
# (`docker volume rm decants-agents_postgres-agents-data`).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log_info() { printf '[info] %s\n' "$*"; }

log_info "Deteniendo containers (data persiste)…"
bash "${REPO_ROOT}/scripts/compose-wrap.sh" down

log_info "Detenidos. Para volver a levantar: bash scripts/up.sh"
