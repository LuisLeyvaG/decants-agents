# TODO

## Pre-requisitos de IAM (BLOQUEANTE para setup.sh)

- [ ] En `decants-infrastructure` (Terraform), elevar los permisos del
      SA de la VM `leyvascents-n8n` (probablemente `leyvascents-n8n-sa`)
      en el proyecto `leyva-scents`. En Fase 1 le dimos solo
      `roles/secretmanager.secretAccessor` (lectura). `setup.sh` necesita
      **crear** 3 secretos nuevos, lo cual requiere uno de:
      - `roles/secretmanager.admin` (más simple, scope = proyecto), o
      - permisos granulares: `secretmanager.secrets.create`,
        `secretmanager.versions.add`, además de los de lectura ya
        existentes.
      Sin esto, `setup.sh` aborta en el dry-test que hace contra la API.

## Inmediato (post-deploy inicial)

- [ ] Correr `setup.sh` en la VM y verificar que los 3 secretos nuevos
      aparecen en Secret Manager (desde la laptop:
      `gcloud secrets list --project=leyva-scents | grep -E 'postgres-agents-password|browserless-token|n8n-webhook-secret'`).
- [ ] `up.sh` + `healthcheck.sh` retornan 0.
- [ ] Verificar que `psql` desde un container efímero en `leyvascents-net`
      conecta a `postgres-agents:5432` con las creds del Secret Manager.
- [ ] Hit a browserless desde otro container en la red:
      `curl http://browserless:3000/json/version?token=$TOKEN`.

## Wiring n8n → containers

- [ ] Credential `postgres-agents` en n8n apuntando a `postgres-agents:5432`,
      DB `agents`, schema search path `agent, public`.
- [ ] Credential `browserless-token` en n8n (HTTP Header Auth).
- [ ] Nodo HTTP Request de prueba en n8n: `GET browserless:3000/content?token=…&url=https://example.com`.

## Smoke tests por agente

- [ ] Agente 1 inserta una `trend_signals` ficticia y la lee de vuelta.
- [ ] Agente 2 inserta un `providers` con `dedup_hash` y comprueba
      que un segundo insert con mismo hash falla por UNIQUE.
- [ ] Agente 3 inserta un `stock_snapshots` referenciando un `providers.id`
      válido; verifica ON DELETE CASCADE.
- [ ] Los 3 escriben en `run_logs` con el mismo `run_id`.

## Despliegue A2 (contenedor) — COMPLETADO (2026-06-06)

> A2 desplegado y el workflow n8n ACTIVO. El contenedor `sourcing-scout` corre en
> `leyvascents-net` y responde `/health`. Próximo run automático: lunes 11:00 UTC.

- [x] **Acceso SSH/ejecución en la VM.** `gcloud compute ssh --tunnel-through-iap`
      desde Windows NO funciona (incompatibilidad gcloud + `plink.exe` (PuTTY) +
      IAP: "Remote side unexpectedly closed"; el `--troubleshoot` reporta 0 issues
      del lado GCP). Workaround usado: **Cloud Console → botón SSH** (navegador).
      PENDIENTE de higiene: para automatizar deploys desde la laptop, usar Cloud
      Shell (Linux/OpenSSH) o forzar OpenSSH en gcloud; `deploy-to-vm.sh` /
      `scripts/*.sh` que dependen de `gcloud compute ssh/scp` tienen el mismo bloqueo
      en Windows.
- [x] **API `iap.googleapis.com` habilitada** (estaba DESHABILITADA en el proyecto;
      causa real del fallo IAP). `gcloud services enable iap.googleapis.com`. Ahora
      el SSH del navegador de Cloud Console funciona.
- [x] **3 secretos en Secret Manager** (v1 enabled): `leyvascents-sourcing-scout-openai-api-key`,
      `leyvascents-agents-postgres-url` (compuesto desde `leyvascents-postgres-agents-password`),
      `leyvascents-trend-analyst-openai-api-key` (prep, sin cablear).
- [x] **`secretAccessor` por-secreto al VM SA** en los 2 que A2 lee. (El de
      trend-analyst queda SIN accessor hasta migrar A1.)
- [x] **`artifactregistry.reader` al VM SA** (nivel proyecto). Verificado por read-back.
- [x] **Build → push → pull → levantar.** Imagen
      `us-central1-docker.pkg.dev/leyva-scents/leyvascents/sourcing-scout:v1`
      (`sha256:fb3dc7b1…`, `--platform linux/amd64`) en AR. En la VM (COS) el pull
      requiere autenticar docker con un token del SA vía metadata server:
      ```
      ACCESS_TOKEN=$(curl -s -H "Metadata-Flavor: Google" \
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" \
        | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
      docker login -u oauth2accesstoken -p "$ACCESS_TOKEN" https://us-central1-docker.pkg.dev
      ```
      Levantado con `docker run -d --name sourcing-scout --restart unless-stopped
      --network leyvascents-net -e GCP_PROJECT=leyva-scents <img>`. `/health` = 2xx
      desde otro container de la red (resolución de nombre `sourcing-scout:8080` OK).
- [x] **Migración `04-providers-web-discovery-v3.sql` aplicada** a `postgres-agents`
      (la DB estaba en 03). Sin esto el upsert v3 del contenedor fallaría.
- [ ] **PENDIENTE — reconciliar el contenedor con compose.** Hoy `sourcing-scout`
      corre vía `docker run` (no compose-managed) porque el repo en la VM está
      desactualizado y el sync depende del SSH/scp roto en Windows. El servicio YA
      está en `docker-compose.agents.yml` (working tree); falta sincronizar el repo
      a la VM (Cloud Shell o arreglar SSH) y reemplazar el `docker run` por
      `compose-wrap.sh up -d sourcing-scout` para manejo unificado.
- [ ] **PENDIENTE — smoke run end-to-end.** El contenedor arrancó (→ secretos OK
      vía ADC), pero la conexión real a Postgres (upsert v3) y la llamada a OpenAI
      solo se ejercitan en un `/run`. Validar con UNA ejecución manual del workflow
      (o `POST /run` con un run_id de prueba) antes de confiar en el cron del lunes;
      revisar que escribe en `agent.providers` y cierra `run_logs` en `succeeded`.

## Deuda A1 — migrar al patrón contenedor (decisión de este sprint)

- [ ] A1 (Trend Analyst) tiene su lógica (taxonomía + umbrales) HARDCODEADA inline
      en un Code node de n8n, fuera de cualquier `.ts` versionado/testeado. Una vez
      A2 valide el patrón contenedor en producción, **migrar A1 al mismo patrón**
      (runtime en contenedor + n8n orquesta) para eliminar el drift y unificar
      arquitectura.
- [ ] **Rename del secreto OpenAI de A1 — BLOQUEADO.** Plan original: crear
      `leyvascents-trend-analyst-openai-api-key` y borrar `leyvascents-openai-api-key`.
      Verificado en diseño que `leyvascents-openai-api-key` tiene `secretAccessor`
      también para `leyvascents-backend-sa` → el backend del e-commerce muy
      probablemente LO CONSUME. **NO borrar ni renombrar** hasta confirmar que el
      backend migró al secreto propio. El secreto nuevo de A1 se crea como prep,
      sin cablear, y el viejo se deja intacto.

## Agente 2 (Sourcing Scout) — estado

> Calibración del scoring cerrada con prompt v3.1.1. Detalle y datos de sizing:
> `workflows/02-sourcing-scout/CALIBRATION.md`.

- [x] **Liveness check** — entregado (`liveness-check.ts`, MVP acotado; abiertos
      body-inspection / proxy / promoción del enum en `02-sourcing-scout/TODO.md`).
- [x] **Contenedor de producción** — `server/` + `openai-responses.ts` +
      `Dockerfile`. `reasoning.effort='low'` ya fijado (coincide A2-semanal Lunes
      11:00 UTC vs A1-diario 08:00 UTC, separados 3h en el pool 500k tier 1).
- [ ] **Estado REVIEW / `insufficient_data`** (sprint de contrato; idealmente junto
      con la promoción del enum `reason` del liveness — tocar el contrato una sola
      vez): proveedor con seguidores pero engagement no evaluable no debería
      forzarse a accepted/filtered.
- [ ] **Bug dedup TLD**: normalizar variantes `.com` / `.com.mx` en `dedup.ts`
      (mismo negocio bajo dos TLDs no deduplica; testigo House of Decants).
- [x] **Workflow n8n + activación** (entregable 6): `agent-2-sourcing-scout-v1`
      (ID `TybvK6IF3r3aKenP`) creado vía MCP y ACTIVO (`active: true`,
      `triggerCount: 1`). Cron Lunes 11:00 UTC. Falta el smoke run end-to-end
      (ver "Despliegue A2 → PENDIENTE smoke run").
- [ ] **Bright Data MX para A2** — no usado en v1 (todo el descubrimiento es vía
      `web_search`, que sale por la IP de OpenAI). Revisar solo si A2 llegara a
      scrapear sitios directamente desde la VM.

## Runbook (pendiente de escribir)

- [ ] Cómo rotar `leyvascents-postgres-agents-password` sin tirar data.
- [ ] Cómo backupear el named volume `postgres-agents-data` (pg_dump cron
      a un bucket GCS es probablemente más simple que snapshots del volume).
- [ ] Cómo upgradar la imagen de browserless (canary primero en un
      compose alternativo).
- [ ] Qué hacer si Bright Data rota credenciales (refresh del .env
      desde Secret Manager + `up.sh` re-apply).

## Mejoras opcionales

- [ ] Métricas: postgres_exporter + scrape desde el Prometheus si existe.
- [ ] Quota de disco para el named volume `postgres-agents-data`
      (alertar si `docker system df` reporta > 15GB en volumes).
- [ ] Rate limiting en browserless (workers vs CONCURRENT).
