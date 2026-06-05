# TODO — 02-sourcing-scout

Pendientes abiertos. Cada entrada dice qué se difirió y por qué, para que la
deuda sea explícita y no una sorpresa.

## Liveness check (MVP — sprint actual)

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
