# TODO — 02-sourcing-scout

Pendientes abiertos. Cada entrada dice qué se difirió y por qué, para que la
deuda sea explícita y no una sorpresa.

## Liveness check (MVP — sprint actual)

> ⚠️ **PROVISIONAL (parche A2, 2026-06-06): el liveness NO descarta por bloqueo de
> IP.** El run #59 perdió 6 de 7 providers por `http_403` — falsos negativos: la VM
> sale por IP de datacenter GCP y los WAF de tiendas .mx devuelven 403/429 a ese
> tráfico. Hasta que vuelva el filtrado real con el proxy residencial Bright Data
> MX (item (b), DIFERIDO), `liveness-check.ts` clasifica en `alive` (2xx) /
> `inconclusive` (403/429/5xx/3xx/otros-4xx/timeout/TLS/error) / `dead` (DNS /
> ECONNREFUSED / 404 / 410 / no_url). **Solo `dead` se descarta**; `inconclusive`
> se persiste con `last_verified_at=null` (`pipeline.ts` escribe `alive ∪
> inconclusive`). **PENDIENTE: con el proxy (b), restaurar el corte real** —
> reclasificar 403/429/timeout como descarte cuando salgan por IP residencial MX.

> ✅ **Re-check de liveness diferido a A4 (decisión 2026-06-06).** El parche de
> liveness (b941a50+c73c06f) se ACEPTÓ con el gate abierto a propósito:
> `pipeline.ts` persiste `alive ∪ inconclusive` con `last_verified_at=NULL`. El
> corte real NO se restaura aquí; el re-check de las filas `agent.providers` con
> `last_verified_at IS NULL` queda delegado a A4, que scrapea cada `catalog_url`
> por residencial MX y sella `last_verified_at` al verificar disponibilidad real
> con éxito. A3 (Site Profiler) NO sella este campo — solo produce recetas. Deuda
> con dueño (A4), no cabo suelto.

El liveness check (`liveness-check.ts`) se entregó deliberadamente acotado:
GET, vivo = HTTP 2xx, IP directa, timeout 5000 ms, paralelo con
`Promise.allSettled`. Quedan abiertos:

- **(a) Inspección de body / detección de patrones-muertos.** Hoy un sitio que
  responde 2xx se considera vivo aunque el body sea una tienda deshabilitada.
  Pendiente: leer el body (ya hacemos GET, no HEAD, justo para no pagar un
  segundo round-trip cuando esto llegue) y detectar páginas-muertas — Cloudflare
  1001, "store unavailable" de Shopify, plantillas de dominio en venta, etc.
  Relacionado: decidir si un 3xx hacia una home viva cuenta como vivo (hoy NO se
  sigue ningún redirect; 3xx = caído).

- **(b) Salida por proxy Bright Data MX.** Hoy el liveness sale por la IP directa
  del runner (ahorro de costos + avanzar rápido). Algunos storefronts bloquean o
  geo-filtran IPs de datacenter y darían un falso "caído". Pendiente: enrutar el
  GET por el `ProxyAgent` de Bright Data ya existente en
  `scripts/brightdata-fetch.ts` (residencial MX), reutilizando su CA scoping y su
  redacción de credenciales.

- **(c) Promoción del literal local `'dead_site'` al enum `reason` del contrato.**
  El liveness tagea los caídos con el literal LOCAL `DEAD_SITE` (`'dead_site'`) en
  `liveness-check.ts`, NO con un valor del enum `reason` de
  `schemas/provider.schema.ts`. Esto fue intencional: este sprint NO reabre el
  contrato (ni el schema, ni el SO schema, ni los 220 tests). Cuando el liveness
  se formalice y su resultado deba persistirse con una razón canónica, promover
  `'dead_site'` al enum `reason` del contrato y migrar el literal local a esa
  referencia única.

## Producción — contenedor en la VM (sprint actual)

A2 corre como contenedor (`server/`, `openai-responses.ts`) en `leyvascents-net`,
expone `POST /run` + `GET /health`, lee secretos de Secret Manager vía el SA de la
VM, y escribe directo a `agent.providers` + cierra `agent.run_logs`. Lógica de
negocio (validateAndFilter/checkLiveness/dedup/ProviderSchema) REUSADA por import,
no duplicada. **Desplegado y workflow ACTIVO el 2026-06-06** (detalle en
`decants-agents/TODO.md → Despliegue A2`). Quedan abiertos:

- **Smoke run end-to-end (BLOQUEANTE de confianza).** El contenedor arranca (→
  secretos OK), pero el upsert v3 a Postgres y la llamada a OpenAI solo se prueban
  en un `/run` real. Hacer UNA ejecución manual del workflow antes de confiar en el
  cron del lunes; confirmar fila en `agent.providers` + `run_logs` en `succeeded`.

- **Reconciliar con compose.** El contenedor corre vía `docker run` (no
  compose-managed) porque el sync del repo a la VM depende del SSH/scp roto en
  Windows. El servicio ya está en `docker-compose.agents.yml`; falta sincronizar el
  repo (Cloud Shell o arreglar SSH) y pasar a `compose-wrap.sh up -d sourcing-scout`.

- **Hardening: compilar a JS en vez de tsx en runtime.** Hoy la imagen corre
  `node --import tsx server.ts` (idéntico a tests/smoke → cero divergencia de
  resolución). A futuro: stage `tsc` con un `tsconfig.build.json` aparte (el
  actual usa `moduleResolution: 'bundler'`, solo para typecheck) → `node dist/`,
  sacando `tsx` del runtime.

- **Tests del servidor/pipeline/persistencia.** El pipeline expone `requestImpl`
  inyectable (vía `openai-responses.ts`) justo para poder testearse con un fake
  sin red ni DB; no se escribió test en este sprint (la lógica de negocio ya está
  cubierta por los 231 tests existentes, que NO se tocaron). Pendiente: un test de
  `runPipeline` con OpenAI fake + un test de `upsertProvider`/`failRun` contra una
  PG efímera.

- **`max_output_tokens` permanente.** Fijado en `openai-responses.ts` = 45_000,
  valor verificado del smoke (cap de la *reserva* TPM; uso real medido ~12.2k,
  sin truncar). Revisar el cap si `incomplete_details.reason` llega a salir
  `max_output_tokens` en un run real (se loguea en `run_logs.metadata`).

## Desacoplado (P1/P3 — siguen pendientes, no los toca el contenedor)

- **REVIEW state / `insufficient_data` (P1).** Proveedor con seguidores pero
  engagement no evaluable no debería forzarse a accepted/filtered. Sprint de
  contrato (idealmente junto con la promoción del enum `reason` del liveness, para
  reabrir el contrato una sola vez).

- **Bug dedup TLD `.com` / `.com.mx` (P3).** Mismo negocio bajo dos TLDs no
  deduplica (testigo: House of Decants → entraría dos veces en `agent.providers`).
  Normalizar variantes en `dedup.ts`.
