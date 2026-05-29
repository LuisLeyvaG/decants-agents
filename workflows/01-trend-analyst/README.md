# 01-trend-analyst

## Propósito

El Agente 1 (Trend Analyst) genera la lista de fragancias con demanda
emergente en el mercado mexicano HNW. Corre en cron `0 */6 * * *` (cada 6
horas) dentro de n8n, le pide a un LLM una lista estructurada de signals
respaldados con evidencia, valida ese output contra Zod, y persiste los
signals que sobrevivan al filtro semántico en `agent.trend_signals`. Cada
ejecución, exitosa o no, también escribe una fila en `agent.run_logs` con
trace end-to-end.

## Inputs / Outputs

| Concepto              | Valor                                                                          |
| --------------------- | ------------------------------------------------------------------------------ |
| Trigger               | Schedule node — cron `0 */6 * * *` (cada 6 horas)                              |
| Modelo LLM            | TBD — Sub-paso 5.3.5                                                           |
| Credentials usadas    | `openai-api-key` (LLM), `postgres-agents` (DB), `browserless-token` (scraping) |
| Tablas escritas       | `agent.trend_signals` (UPSERT por `(brand, fragrance_name, run_id)`), `agent.run_logs` |
| Schema de output      | `TrendAnalystOutputSchema` (ver abajo)                                         |

## Contrato del output

La fuente de verdad estructural del output del LLM es
[`schemas/trend-signal.schema.ts`](schemas/trend-signal.schema.ts).
`TrendAnalystOutputSchema` es el contrato canónico — todo lo que no parsee
contra él se descarta y el run se marca `status='failed'` en
`agent.run_logs`.

Constantes públicas (`SENTIMENT_VALUES`, `DEMAND_SCORE_MIN/MAX`,
`CONFIDENCE_MIN/MAX`, `TREND_SIGNALS_MAX_PER_RUN`, etc.) son la única
referencia para los bounds. Si cambian, cambian aquí.

### Campos sensibles al cambio (v1 → versiones posteriores)

- `brand_line`: nullable string, **siempre presente como key**. Distingue
  líneas premium dentro de una marca (`"Les Exclusifs"`, `"La Collection
  Privée"`, etc.) del mainline (`null`). El Code node downstream cruza
  `(brand, brand_line)` contra la taxonomía canónica para resolver el
  bucket operativo (A/B/C/D/E/F).
- `reasoning_summary`: síntesis analítica del modelo, distinta de
  `evidence_quotes` (que son literales). Self-contains el "por qué" del
  signal para auditoría humana sin necesidad de re-procesar las quotes.

La resolución del bucket NO es responsabilidad del LLM — es del Code node
post-validación. Si el LLM emite una marca no listada en la taxonomía
canónica, el signal NO se rechaza: se enruta a
`agent.unknown_brand_candidates` (tabla a crear en sub-paso 5.3.4) para
revisión humana. Esto crea un loop de descubrimiento de marcas nuevas.

### System prompt

Las instrucciones que el workflow inyecta como `system` message en cada
llamada al LLM viven en [`prompts/system-prompt.md`](prompts/system-prompt.md).
El prompt cita literal las constantes del schema y embebe la taxonomía
canónica de marcas (v1.0). Cambios al prompt requieren bump de versión
en el HTML frontmatter del propio archivo.

### JSON Schema para OpenAI Structured Outputs

El JSON Schema literal que el workflow envía a OpenAI en el campo
`text.format` vive en
[`schemas/trend-analyst-output.schema.json`](schemas/trend-analyst-output.schema.json).

Generación: `npm run build:schema` (desde `workflows/`). Toma el Zod
`TrendAnalystOutputSchema`, lo convierte vía `z.toJSONSchema()`,
post-procesa para cumplir restricciones de Structured Outputs estricto
(`additionalProperties: false`, todos los fields en `required[]`,
sin `$ref`), y lo envuelve en el formato `{ name, strict, schema }`
que espera la API.

Cambios al Zod schema deben acompañarse de `npm run build:schema` y
commit del `.json` regenerado. El pretest hook lo automatiza para que
los tests del schema generado fallen si hay drift.

## Filtros semánticos (post-validación)

El schema valida **estructura**, no **calidad**. Después de Zod, el Code
node del workflow filtra:

- `demand_score >= 60` — descarta señales débiles.
- `confidence >= 0.7` — descarta señales en las que el propio modelo no
  cree.

Solo los signals que pasen AMBOS umbrales llegan al UPSERT en
`agent.trend_signals`. Los umbrales viven como constantes exportadas
en [`validate-and-filter.ts`](validate-and-filter.ts)
(`DEMAND_SCORE_THRESHOLD`, `CONFIDENCE_THRESHOLD`). Cambiarlos requiere
ajustar la constante + sus tests; el schema Zod no los conoce a propósito,
para que estructura y calidad permanezcan ortogonales.

## Criterio de terminado del agente

> run manual desde n8n UI produce row en `agent.run_logs` con
> `status='succeeded'`; el filtro semántico se calibra en paso posterior.

## Sub-pasos restantes

> **Plan congelado.** Los sub-pasos están en este orden definitivo. Si surge
> una razón para reordenar, se discute en chat antes de tocar este README.

- [x] 5.3.1 — Workspace TS (`workflows/package.json`, `tsconfig`, `jest`).
- [x] 5.3.2 — Schema Zod `trend-signal.schema.ts` con 21 tests base.
- [x] 5.3.2.5 — Schema patch: `brand_line` + `reasoning_summary`, 31 tests.
- [x] 5.3.3 — [`prompts/system-prompt.md`](prompts/system-prompt.md) v1.0.1.
- [x] 5.3.4 — Code node `validate-and-filter`: migration SQL +
      [`taxonomy.ts`](taxonomy.ts) + [`validate-and-filter.ts`](validate-and-filter.ts)
      + tests.
- [ ] 5.3.5 — Decisión de modelo OpenAI (gpt-5.4-mini vs gpt-5.4) +
      crear credentials en n8n UI (Postgres + OpenAI).
- [ ] 5.3.6 — Construcción del workflow en n8n UI y export a
      `trend-analyst.v1.workflow.json`.
- [ ] 5.3.7 — Smoke test end-to-end contra `postgres-agents` real;
      criterio: 1 row en `agent.run_logs` con `status='succeeded'`.
- [ ] 5.3.8 — Cron `0 */6 * * *` habilitado en producción + alerting
      sobre `run_logs.status='failed'`.
