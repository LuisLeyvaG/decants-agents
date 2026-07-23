# A2 Sourcing Scout — Cierre de fase de calibración (hito 2R.4, prompt v3.1.1)

**Estado:** la calibración del *scoring* de A2 queda CERRADA con el system prompt en v3.1.1.
Esto **NO** cierra A2 completo — faltan liveness, estado REVIEW, conexión a n8n y producción
(ver Diferido).

## Estado verificado (3 runs de calibración reales, dumps en `tmp/`)

1. **`trust_quality` redefinido a confianza externa verificable (v3.1.0).** El núcleo del score
   es prueba social humana (seguidores activos + posts recientes) y menciones de terceros, no la
   autodescripción del sitio. **Validado:** los fallos originales (Mx Decants con redes vacías,
   Decants Mexico) caen consistentemente bajo el corte en los 3 runs; los anclas legítimos
   (Alambique ~0.90, Abscents ~0.85) se mantienen accepted y estables; sin masacre de legítimos.
2. **Escáneres técnicos subordinados (v3.1.1).** Virus / URL-reputation scanners (gridinsoft,
   scamadviser) pueden RESTAR `trust_quality` ante un reporte concreto malo, pero **nunca SUMAR**
   ni sustituir prueba social; un veredicto "limpio" es neutral. Bug "escáner limpio infla el
   score" **cerrado** (testigo Mr Decants: 0.42 → 0.28; el escáner ya no levanta el score).
   **Matiz importante:** el 0.28 es correcto DADO lo que el agente puede ver, pero Mr Decants sí
   tiene prueba social real en TikTok que `web_search` no indexa (ver Diferido §Búsqueda de
   TikTok). El caso testigo NO debe leerse como "mal proveedor resuelto" sino como "buen
   proveedor que hoy no podemos evaluar por un límite de herramienta".
3. **Umbrales SIN CAMBIO: `TRUST_QUALITY_THRESHOLD=0.6`, `CONFIDENCE_THRESHOLD=0.7`.** La
   clasificación (qué lado del corte) es estable en los 3 runs; la zona del corte (0.54–0.59)
   tiene ruido de magnitud ±0.1–0.2 pero el cuerpo no cambia de lado. **Decisión:** no mover las
   constantes con la muestra actual; los 3 dumps quedan en `tmp/` para re-juzgar a mano si hace
   falta.
4. **Smoke de calibración (`scripts/smoke-sourcing.ts`) queda como herramienta reutilizable,**
   validada en todos sus caminos en vivo: pre-flight (prompt fresco / schema / key), HTTP 400,
   timeout, 429 (rate-limit vs quota), y `completed`.

## Diferido (lo que A2 AÚN NO tiene, con razón)

- **Liveness check** — pendiente, sprint propio. Diseño acordado: paso **async DESPUÉS** de
  `validateAndFilter` (no dentro — la función se mantiene pura); sitios caídos → `filteredOut`
  con `reason: 'dead_site'`. Es lo que desambigua "caído" de "vivo-pero-chico" (testigo: Decants
  Mexico). No se instruye al LLM (lee snippets cacheados).
- **Estado REVIEW / `insufficient_data`** — diferido a sprint de contrato, idealmente **junto con
  liveness** para tocar el contrato una sola vez. Caso: proveedor con seguidores pero engagement
  no evaluable (testigo: House of Decants, que oscila 0.66 / 0.58 / 0.54 alrededor del corte) →
  debería caer en REVIEW, no forzarse a accepted/filtered.
- **Bug dedup `.com` vs `.com.mx`** — el mismo negocio bajo TLDs distintos no se deduplica:
  `dedup_hash` usa dominio como último recurso y `normalizeDomain` trata `houseofdecants.com` y
  `houseofdecants.com.mx` como distintos → entraría dos veces en `agent.providers`. Pendiente:
  normalizar variantes TLD/ccTLD en `dedup.ts`.
- **Búsqueda de TikTok — limitación de HERRAMIENTA, no de prompt.** `web_search` indexa mal
  TikTok, donde vive parte de la prueba social del nicho (testigo: Mr Decants, tq=0.28 — tiene
  comunidad real en TikTok que el agente no puede ver). **No accionable vía prompt;** documentado
  como limitación, no como tarea.
- **Conexión a n8n / producción** — A2 sigue sin estar en el workflow ni activo.

## Sizing para producción (2R.4b)

- **Reserva TPM real por corrida ≈ 104–130k:** input ~100–120k (inflado ~28% por las queries de
  corroboración off-site de §4) + colchón de reasoning que el limiter reserva POR ENCIMA de
  `max_output_tokens`. **Conclusión: `max_output_tokens` NO acota la reserva.**
- A2 (semanal) + A1 (diario 02:00) comparten el pool de **500k TPM tier 1** → dimensionar
  coincidencias antes de soltar A2 desatendido. (Tier 2 sube el TPM pero requiere $50 de spend
  acumulado — llega solo con el tiempo.)
- **Considerar `reasoning.effort='low'` en producción:** el output real fue ~12k tokens, no
  justifica `'medium'`.
- **Diagnóstico de 429 (aprendizaje):** fueron **autosaturación** por reintentos concurrentes
  reservando contra el pool, NO techo externo (el dashboard mostró tráfico bajo). Un disparo
  aislado entra. El manejo de 429 debe distinguir **rate-limit** (reintentable, respetando el
  Retry-After completo, sin ráfaga) de **quota** (no reintentable).

## Referencia de dumps (gitignored, `tmp/`)

> Los 3 dumps viven en `tmp/`, que está **gitignored — NO versionados**. Este registro resume
> sus hallazgos; no los busques en git esperando recuperarlos.

- `smoke-sourcing-2026-06-03T21-16-17-792Z.json` — v3.1.0, run A (14 proveedores)
- `smoke-sourcing-2026-06-05T18-15-05-198Z.json` — v3.1.0, run B (10)
- `smoke-sourcing-2026-06-05T20-03-55-833Z.json` — v3.1.1, run C (12)
