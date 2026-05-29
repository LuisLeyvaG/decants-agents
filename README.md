# decants-agents

Containers auxiliares para el sistema agéntico de inventario de Leyva Scents.
Corre en la VM `leyvascents-n8n` (GCP, Container-Optimized OS, us-central1-a)
junto a n8n y caddy, en la red Docker existente `leyvascents-net`.

## Qué corre aquí

| Servicio       | Imagen                                   | Para qué                                       | Puerto host |
| -------------- | ---------------------------------------- | ---------------------------------------------- | ----------- |
| postgres       | `postgres:15-alpine`                     | Estado persistente de los 3 agentes            | ninguno     |
| browserless    | `ghcr.io/browserless/chromium:latest`    | Chrome headless para scraping JS-heavy         | ninguno     |

Ambos containers viven en `leyvascents-net` y solo son alcanzables desde
n8n (y entre sí). No hay port mapping al host.

## Decisión arquitectural: sin sidecar proxy

Browserless se conecta directo a Bright Data residencial vía el flag
`--proxy-server`, configurado por env var `PROXY_SERVER`. No usamos un
sidecar tipo `mitmproxy` ni un container intermedio. Una capa menos que
mantener, una capa menos que puede fallar.

## Orden de comandos

### Desde la laptop (una vez)

```
bash scripts/deploy-to-vm.sh
```

Hace push del repo a `/home/$USER/agents` en la VM.

### En la VM (primera vez)

```
cd ~/agents
bash scripts/setup.sh
bash scripts/up.sh
bash scripts/healthcheck.sh
```

`setup.sh` es idempotente: genera secretos solo si no existen ya en
Secret Manager, y construye `.env` con permisos 600.

### En la VM (operación diaria)

```
bash scripts/up.sh         # levanta (idempotente)
bash scripts/healthcheck.sh
bash scripts/down.sh       # detiene preservando volumes
```

## docker compose vía wrapper

La VM corre Container-Optimized OS y no tiene `docker compose` instalado.
`scripts/compose-wrap.sh` ejecuta `linuxserver/docker-compose:latest` desde un container
desechable, montando el socket de Docker. Todos los `up.sh` / `down.sh` /
`healthcheck.sh` usan este wrapper internamente.

## Secret Manager (project `leyva-scents`)

Pre-existentes (no se tocan):
- `leyvascents-brightdata-endpoint` — `host:port` del residencial MX
- `leyvascents-brightdata-username`
- `leyvascents-brightdata-password`
- `leyvascents-openai-api-key`
- `leyvascents-inventory-webhook-secret`

Creados por `setup.sh` si no existen:
- `leyvascents-postgres-agents-password`
- `leyvascents-browserless-token`
- `leyvascents-n8n-webhook-secret`

## Schema Postgres (`agent`)

| Tabla                     | Escribe                | Para qué                                  |
| ------------------------- | ---------------------- | ----------------------------------------- |
| `agent.trend_signals`     | Agente 1 Trend Analyst | Señales de demanda por fragancia          |
| `agent.providers`         | Agente 2 Sourcing      | Proveedores deduplicados y scoreados      |
| `agent.stock_snapshots`   | Agente 3 Availability  | Disponibilidad y precio observados        |
| `agent.run_logs`          | Los 3 agentes          | Trace end-to-end y métricas de cada run   |

Schema completo en [postgres/init/01-schema.sql](postgres/init/01-schema.sql).

## NO está en este repo

- El código de los agentes (vive en n8n como nodos AI Agent + tools).
- Caddy o cualquier reverse proxy (no se expone nada de aquí a internet).

## Workflows de n8n

Los workflows de n8n viven en [`workflows/`](workflows/) de este mismo repo,
versionados como JSON exportado + schemas TypeScript + system prompts en
Markdown. Ver `workflows/README.md` para la convención completa.
