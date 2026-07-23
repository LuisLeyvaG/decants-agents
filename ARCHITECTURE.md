<!--
  Leyva Scents — Virtual Inventory Agentic System
  Architecture document v3 (web-discovery pivot + fulfillment-aware)
  Status: canonical. Supersedes the 3-agent scraping design (v1/v2).
  Last updated: 2026-05-29
-->

# Leyva Scents — Sistema Agéntico de Inventario Virtual (Arquitectura v3)

> **Documento canónico.** Reemplaza el diseño de 3 agentes basado en scraping de
> Maps/MercadoLibre/Instagram (v1/v2). Si algo en código, prompts o conversaciones
> contradice este documento, este documento gana — o el documento está desactualizado
> y hay que corregirlo aquí primero.

---

## 0. Por qué existe este documento (el pivote)

El diseño original descubría proveedores raspando plataformas que hostean a terceros
(Google Maps, MercadoLibre, Instagram). Las tres murieron por la misma raíz: **esas
plataformas protegen el acceso por diseño.**

| Fuente | Causa de muerte |
|---|---|
| MercadoLibre | Anti-bot proof-of-work (Anubis/Akamai) + API de búsqueda pública cerrada desde abril 2025 (403). Baja confiabilidad de sellers de decant. |
| Instagram | Sirve `httpErrorPage` a anónimos; `web_profile_info` enriquece perfiles conocidos pero `tags/web_info` (descubrimiento por hashtag) da 302. No descubre. |
| Google Maps | Places API funciona, pero **casi no existen tiendas de decants** catalogadas en Maps. Fuente vacía para el dominio. |

**El pivote:** en vez de raspar plataformas hostiles, un LLM con web search descubre
tiendas de decants con **sitio web propio** en la web abierta. Ventajas:

- Descubrimiento legítimo: los sitios propios *quieren* ser encontrados.
- Estable: no hay anti-bot que rote cada semana.
- **El catálogo ya viene estructurado en el sitio del proveedor** → el agente de
  disponibilidad lo lee de forma estable, sin normalizar fotos/Excels/DMs.
- Filtra en la fuente: exigir sitio web = exigir proveedor "scrapeable" y sostenible.

---

## 1. Modelo de negocio (define toda la arquitectura)

**Modelo C — Arbitraje por tier de confianza.**

- **Siempre se vende antes de comprar.** Cero capital inmovilizado en stock físico.
  No existe "capa de capital / presupuesto de caja" porque no se pre-compra nada.
- El eje del híbrido **NO es** "stock real vs arbitraje" (todo es arbitraje). El eje
  es **cuánta confianza de cumplimiento** hay en cada proveedor:
  - **Tier alto:** relación estable, baja volatilidad. Publica con colchón delgado,
    márgenes competitivos; el Fulfillment Guard es confirmación rápida.
  - **Tier bajo (descubrimiento nuevo/volátil):** Fulfillment Guard estricto y
    bloqueante, colchón de volatilidad grueso, publicación conservadora.

**Consecuencia crítica:** como cada venta es una promesa aún no cumplida, el
**Fulfillment Guard (A6) es crítico y bloqueante**, no liviano. Ninguna venta se
confirma sin re-validar stock real del proveedor en vivo, ANTES de cobrar.

**Riesgo central que el sistema mitiga:** vender a un cliente HNW algo que no se puede
entregar. En el premium mexicano, una cancelación destruye más reputación que la que
10 ventas construyen. Todo el diseño existe para que el inventario publicado sea
cumplible, no solo barato.

---

## 2. Las dos dimensiones de confianza de un proveedor (no confundir)

Un proveedor tiene **dos** trust scores, medidos en momentos distintos por agentes
distintos. El schema los separa desde el día 1.

| Campo | Qué mide | Quién lo llena | Cuándo |
|---|---|---|---|
| `trust_quality` | Legitimidad / calidad: ¿vende decants auténticos premium? ¿catálogo serio? ¿señales de negocio real? | **A2 (Sourcing Scout)** | Al descubrir, vía juicio LLM + reglas |
| `trust_fulfillment` | Confiabilidad de cumplimiento: cuando le compro, ¿cumple? | **A6 (Fulfillment Guard)** | Con el tiempo, vía resultado real de cada venta |

Ambos son `numeric` con `CHECK [0,1]`. `trust_quality` es `NOT NULL` (A2 siempre lo
produce al descubrir). `trust_fulfillment` es **NULLABLE y arranca en `NULL` ("sin dato
aún", distinto de un neutro medido como `0.5`)** — A6 debe poder distinguir "todavía no
hay ventas que lo calibren" de "se midió y salió neutro". Se calibra con datos de
cumplimiento real; es la señal más pura de confiabilidad — más que cualquier reputación
scrapeada.

---

## 3. El pipeline (6 etapas)

```
A1 Trend Analyst      (cron 6h)      → qué se desea            [EN PRODUCCIÓN]
A2 Sourcing Scout     (semanal)      → quién lo vende + trust_quality
A3 Site Profiler      (al descubrir) → cómo leer cada sitio (receta)
A4 Availability Match  (diario)      → precio/stock crudo
   └─ Capa de Sanidad  (obligatoria) → ¿el dato es confiable?
A5 Inventory Reconciler (tras A4)    → margen dinámico → publica en Medusa
A6 Fulfillment Guard  (en la venta)  → re-valida en vivo, bloqueante  [hook Medusa]
```

### A1 — Trend Analyst *(ya en producción, sin cambios)*
- **Cadencia:** cron `0 */6 * * *`.
- **Hace:** LLM (gpt-5.4) + web_search → señales de demanda en el mercado HNW mexicano
  (CDMX, MTY, GDL, QRO), cada una con evidencia.
- **Valida:** Zod Structured Outputs estricto → filtro `demand_score >= 60 AND
  confidence >= 0.7` → bucket A–F por taxonomía (Code node, no LLM).
- **Escribe:** `agent.trend_signals`; marcas no reconocidas → `agent.unknown_brand_candidates`.
- **Responde:** ¿qué quiere la gente?

### A2 — Sourcing Scout *(rediseñado — web discovery)*
- **Cadencia:** semanal.
- **Hace:** LLM (gpt-5.4) + web_search → descubre y valida tiendas de decants con
  **sitio web propio**, preferentemente CDMX / envíos desde México.
- **Criterios de validación (el LLM verifica con evidencia):**
  - **DURO:** tiene sitio web propio funcional con catálogo visible. Sin esto, no entra.
  - Preferente CDMX / envíos nacionales desde México.
  - Vende decants/fracciones (no solo frascos completos).
  - Maneja marcas de la lista de referencia (señal de catálogo premium).
  - Señales de legitimidad: contacto visible, presencia consistente, antigüedad.
- **Salida:** proveedor + `catalog_url` + `evidence_urls` + `discovery_query` +
  `trust_quality` + `confidence`. La señal de calidad (`trust_quality`) sale del juicio
  LLM validado por reglas duras (como A1), NO de una fórmula aritmética — el scoring
  determinístico de 5 dimensiones (y su `composite_score`/`tier`) se retiró en v3.
- **Escribe:** `agent.providers`; candidatos dudosos → revisión humana.
- **Patrón de código:** gemelo de A1 (Responses API + web_search + Structured Outputs
  + validateAndFilter + Postgres + run_logs).
- **Responde:** ¿quién vende decants de forma scrapeable y confiable?

### A3 — Site Profiler *(nuevo)*
- **Cadencia:** rara — al descubrir un proveedor nuevo, o cuando A4 marca su receta
  como `stale`. **NO** corre en cada verificación de stock.
- **Por qué separado de A4:** analizar estructura es caro/lento/LLM pero la estructura
  de un sitio casi nunca cambia. Ejecutar el scraping es barato/rápido y frecuente.
  Separarlos permite optimizar cada uno por su cadencia natural. Mezclarlos = o pagas
  LLM en cada run de stock (carísimo) o tus recetas se quedan obsoletas.
- **Hace:** LLM mira el HTML de cada `catalog_url` y produce una **receta de scraping**:
  cómo buscar un perfume, dónde está el precio, el stock, el tamaño del decant, el
  título. Pueden requerirse fetches con `browserless` para sitios JS-heavy.
- **Escribe:** `agent.site_recipes` (1 receta por proveedor, `ON DELETE CASCADE`).
- **Responde:** ¿cómo leo este sitio en particular?

### A4 — Availability Matcher *(el ejecutor — aquí renace Bright Data)*
- **Cadencia:** diaria.
- **Dirigido por A1:** NO scrapea el catálogo entero. Solo los perfumes que A1 marcó
  como hypeados (feedback loop demanda → verificación). Solo se gasta scraping en lo
  que se va a vender.
- **Hace:** para cada (perfume hot × proveedor): aplica la receta de A3 y scrapea
  precio/disponibilidad reales con `brightdata-fetch.ts` (+ `browserless` si JS-heavy).
  **Sin LLM en el camino crítico** — solo ejecuta recetas.
- **Capa de Sanidad (OBLIGATORIA, entre A4 y A5):** antes de confiar en cualquier
  snapshot, valida:
  - ¿El precio es numérico y no null?
  - ¿Está en el rango histórico esperado para ese perfume/tamaño?
  - ¿El formato tiene sentido (no es un SKU, no es un teléfono)?
  - **Falla → descarta el snapshot + dispara re-profiling de A3 para ese sitio.**
    Un sitio que cambia `.price-box` a `.price` no "se cae": devuelve null o basura.
    Un precio mal scrapeado que llega a Medusa es cómo vendes Amouage a $50. La capa
    de sanidad ES el detector de cambio estructural silencioso.
  - Pasa → escribe `agent.stock_snapshots` + actualiza la **volatilidad histórica**
    del proveedor (insumo del colchón de A5).
- **Responde:** ¿está disponible y a cuánto, hoy?

### A5 — Inventory Reconciler *(el decisor — toca Medusa)*
- **Cadencia:** tras cada run de A4.
- **Hace:** compara proveedores para cada perfume, elige el mejor por precio Y
  conveniencia (no solo el más barato — pondera trust_fulfillment), aplica el
  **margen dinámico defensivo**, y actualiza el inventario de Leyva Scents en Medusa.
- **Fórmula de precio (NO el ingenuo "costo + margen"):**
  ```
  precio_final = costo_proveedor
               + colchón_de_volatilidad   (función de la desviación histórica del
                                            proveedor — tier bajo/volátil = colchón
                                            más grueso; dato que A4 genera con el tiempo)
               + margen
               + costo_logístico_real      (envío CDMX / nacional)
               + comisión_de_pasarela
  ```
  El segmento premium crece ~12% anual: hay espacio de margen; úsalo para protegerte
  de la volatilidad, no solo para competir en precio.
- **Escribe:** inventario en Medusa (vía API) + traza qué snapshot/proveedor respalda
  cada publicación.
- **Responde:** ¿qué publico, a qué precio, de qué proveedor?

### A6 — Fulfillment Guard *(crítico, bloqueante — hook síncrono en Medusa)*
- **NO es un workflow de n8n de background.** Es un hook síncrono en el checkout de
  Medusa (subscriber/middleware), ejecutado EN tiempo real DURANTE la venta, antes de
  cobrar. Esto cambia su implementación: es código en el backend de Medusa, no n8n.
- **Hace:** cuando el cliente intenta comprar, re-valida el stock real del proveedor
  elegido en vivo:
  - **Confirmado →** procede el pago; tú compras al proveedor y cumples.
  - **No disponible →** ofrece alternativa (otro proveedor del mismo perfume) o cancela
    ANTES de cobrar. Nunca después.
- **Registro promesa-vs-cumplimiento:** cada venta se traza contra el snapshot/proveedor
  que la respaldó. Cuando algo falla, se sabe exactamente qué snapshot mintió.
- **Feedback a A2:** cada resultado del Guard alimenta `trust_fulfillment` del proveedor.
  El sistema aprende quién cumple de verdad, calibrando los tiers con datos reales.
- **Responde:** ¿puedo cumplir ESTA venta, ahora mismo?

---

## 4. Diagrama de flujo de datos

```
┌────────────────────────────────────────────────────────────────┐
│ A1 Trend Analyst (6h)                                            │
│   agent.trend_signals  ── "qué perfumes importan" ──┐            │
└─────────────────────────────────────────────────────┼───────────┘
                                                       │
┌──────────────────────────────────────────────────┐  │
│ A2 Sourcing Scout (semanal)                        │  │
│   LLM+web → tiendas con sitio+catálogo+decants     │  │
│   agent.providers (+ catalog_url, trust_quality)   │  │
└───────────────────────┬────────────────────────────┘  │
                        │                                │
┌───────────────────────▼─────────────────┐             │
│ A3 Site Profiler (al descubrir / stale)  │             │
│   LLM lee HTML → receta de scraping      │             │
│   agent.site_recipes                     │             │
└───────────────────────┬─────────────────┘             │
                        │                                │
┌───────────────────────▼────────────────────────────────▼────────┐
│ A4 Availability Matcher (diario)  ← Bright Data + browserless    │
│   por (perfume_hot × proveedor): aplica receta → scrapea         │
│   ┌─ CAPA DE SANIDAD ─────────────────────────────────────────┐  │
│   │ ¿numérico? ¿en rango? ¿formato válido?                     │  │
│   │   falla → descarta + dispara re-profiling A3 ──────────────┼──┼─→ (a A3)
│   │   pasa  → snapshot + actualiza volatilidad del proveedor   │  │
│   └────────────────────────────────────────────────────────────┘  │
│   agent.stock_snapshots                                          │
└───────────────────────┬──────────────────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────────────────┐
│ A5 Inventory Reconciler (tras A4)  → Medusa API                   │
│   precio = costo + colchón_volatilidad(tier) + margen             │
│            + logística + pasarela                                 │
│   publica inventario + traza proveedor/snapshot de respaldo       │
└───────────────────────┬──────────────────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────────────────┐
│ A6 Fulfillment Guard (EN LA VENTA, bloqueante)  ← hook Medusa     │
│   cliente compra → re-valida stock en vivo                        │
│     confirmado → cobra, compra al proveedor, cumple               │
│     no dispo  → alternativa o cancela ANTES de cobrar             │
│   registra promesa-vs-cumplimiento                                │
│   → actualiza trust_fulfillment ──────────────────────────────────┼─→ (a A2)
└────────────────────────────────────────────────────────────────────┘
```

---

## 5. Esquema de datos (`agent` schema)

Existentes (A1): `agent.trend_signals`, `agent.unknown_brand_candidates`,
`agent.run_logs`, `agent.providers`.

Cambios y adiciones para v3:

### `agent.providers` (rediseñado para web-discovery)
- `source` ahora es `'web'` — `text CHECK (source = 'web')` (las fuentes
  `maps/mercadolibre/instagram` se retiran; es un CHECK, no un ENUM).
- **DURO:** `catalog_url` (`text NOT NULL` — sin sitio no hay proveedor).
- `evidence_urls` (`text[] NOT NULL DEFAULT '{}'` — qué encontró el LLM para validar; **no
  jsonb**). El `DEFAULT '{}'` es una red de seguridad de tipo, **no** un permiso de entrada:
  un array vacío NO es un proveedor válido — `validateAndFilter` (2R.3) rechaza evidencia
  vacía como regla dura.
- `discovery_query` (`text NOT NULL` — qué búsqueda lo descubrió, para auditar).
- `trust_quality` (`numeric NOT NULL, CHECK [0,1]` — legitimidad evaluada por A2).
- `trust_fulfillment` (`numeric NULLABLE sin default, CHECK (IS NULL OR [0,1])` —
  cumplimiento, llenado por A6; **arranca en `NULL` = "sin dato aún"**, no neutro).
- `confidence` (`numeric NOT NULL, CHECK [0,1]` — confianza del LLM en la validación).
- Conserva: `name`, `whatsapp`, `instagram_handle`, `dedup_hash` (UNIQUE
  `providers_dedup_hash_key`), `status` (CHECK `active/inactive/suspended`), `source_id`
  (nullable, traza), `last_verified_at` (nullable, la llena A4 — no A2), `run_id`,
  `created_at`/`updated_at`, trigger `providers_set_updated_at`. Se retiran las 5
  dimensiones de score determinístico del diseño viejo (+ `composite_score`, `tier`,
  `avg_whatsapp_ms`).
- **Dedup:** identidad por prioridad estricta **tel > ig > dom** — `dom:<dominio>` se deriva
  de `catalog_url` (vía `normalizeDomain`) y solo entra cuando no hay ni teléfono ni handle.
- **Verificar contra `\d agent.providers` real antes de migrar** (lección de `brand_line`).
  Aplicado en `04-providers-web-discovery-v3.sql` y verificado contra el `\d` real.

### `agent.site_recipes` (nueva — A3)
- `provider_id` (FK → providers, `ON DELETE CASCADE`).
- `search_url_template` (text — cómo construir una búsqueda, ej. `?s=<query>`).
- `selectors` (jsonb — precio/stock/tamaño/título).
- `recipe_status` (`active | stale | failed`).
- `last_profiled_at`, `profiler_run_id`.

### `agent.stock_snapshots` (nueva — A4)
- `provider_id` (FK → providers, `ON DELETE CASCADE`).
- `fragrance` (matchea `trend_signals`).
- `size_ml`, `price_mxn`, `available` (bool).
- `passed_sanity` (bool — resultado de la capa de sanidad).
- `scraped_at`, `snapshot_run_id`.

### `agent.fulfillment_log` (nueva — A6)
- `provider_id` (FK), `fragrance`, `promised_price`, `promised_at`,
  `fulfilled` (bool), `resolution` (`confirmed | alternative | cancelled`),
  `sale_ref` (referencia a la orden de Medusa).

---

## 6. Infraestructura (sin cambios respecto a v2)

- **VM `leyvascents-n8n`** (GCP COS, `us-central1-a`), egress por IP estática
  `34.29.82.60` (allowlisted en Bright Data). Red Docker `leyvascents-net`.
- **postgres-agents** (`postgres:15-alpine`): schema `agent`. Sin puertos al host.
- **browserless** (Chromium headless): scraping JS-heavy (A3/A4), conectado a
  Bright Data residencial MX vía `--proxy-server`. Sin puertos al host.
- **n8n** en `n8n.leyvascents.com`: orquesta A1–A5.
- **OpenAI:** gpt-5.4 + web_search (Responses API) para A1, A2, A3.
- **Bright Data:** residential MX, zona `leyvascents_mx`, gateway
  `brd.superproxy.io:33335`, CA scoped al ProxyAgent (no global). Cost guard $2/run.
- **Medusa:** backend de e-commerce (A5 escribe inventario, A6 hook de checkout).

---

## 7. Qué se conserva del trabajo previo (Sprints 1–2)

- `provider.schema.ts` — se ADAPTA al nuevo shape (web source, catalog_url duro, las
  dos dimensiones de trust). El armazón Zod se reutiliza.
- `dedup.ts` — se conserva intacto (dedup por teléfono/handle, + dominio del sitio web).
- `brightdata-fetch.ts` + `cost-guard.ts` — NO se tiran. Pasan a ser la infraestructura
  de scraping de A4. Todo el trabajo de domesticar Bright Data (CA scoped, byte-accounting
  on-wire, circuit breaker) se cobra completo en A4.
- Patrón A1 (Responses API + Structured Outputs + validateAndFilter + run_logs) — se
  replica en A2 y A3.

Se retira: scoring determinístico de 5 dimensiones (lo reemplaza juicio LLM + reglas),
parsers de Maps/ML/IG (archivados).

---

## 8. Orden de implementación (por dependencia, no por número)

- **Bloque I — Cerrar A2** (Sourcing Scout web-discovery). Cuello de botella: sin
  proveedores, nada aguas abajo existe. Sprints 2R.1–2R.5.
- **Bloque II — A3 Site Profiler.** Depende de A2 (necesita `catalog_url`).
- **Bloque III — A4 Availability Matcher + Capa de Sanidad.** Renace Bright Data.
  Depende de A3.
- **Bloque IV — A5 Inventory Reconciler + Medusa.** Depende de A4.
- **Bloque V — A6 Fulfillment Guard** (hook Medusa). Depende de A5 y de checkout operando.

---

## 9. Principios de diseño no negociables

1. **Fallo aislado por etapa.** Un fallo degrada esa etapa, no tumba el inventario.
2. **Nunca vender lo que no se puede cumplir.** A6 bloqueante es el seguro.
3. **La capa de sanidad es obligatoria.** Ningún precio sin validar llega a Medusa.
4. **Verificar el schema real (`\d`) antes de migrar.** Nunca asumir de memoria.
5. **LLM para juicio (descubrir, perfilar); código determinístico para ejecutar
   (scrapear, validar, fijar precio).** No pagar LLM en caminos calientes.
6. **El cumplimiento real (A6) calibra la confianza (A2), no las heurísticas.**
