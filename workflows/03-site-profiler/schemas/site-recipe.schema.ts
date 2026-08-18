/**
 * Zod contract for Agente 3 (Site Profiler) — the per-provider scraping recipe.
 *
 * A single `SiteRecipeSchema` models ONE recipe: how to read a specific
 * storefront (how to search it, where the product title/brand/sku/currency live,
 * and — crucially — how its VARIANTS/SIZES expose price & stock). A3 produces it
 * via LLM + Structured Outputs when a new provider is discovered (or when A4
 * marks an existing recipe `stale`); A4 EXECUTES it in its daily scrape with NO
 * LLM in the critical path.
 *
 * THE VARIANT DIMENSION (the ml axis of the decants business). Recon proved a
 * single product carries N sizes with N prices/stocks, and that storefronts
 * diverge in HOW they expose this in JSON-LD:
 *   - Shopify  → `offers` is an ARRAY of `Offer`, one per size, each with its own
 *                `price` (and `availability`). schema.org is "http://schema.org".
 *   - Woo      → `offers` is a SINGLE `AggregateOffer` with `lowPrice`/`highPrice`
 *                and NO per-size price. schema.org is "https://schema.org".
 * The old flat title/price/stock contract could not model this; `selectors` now
 * carries a `variants` sub-object whose shape is driven by a `mode` enum.
 *
 * Maps to `agent.site_recipes` (postgres/init/05-site-recipes.sql). This is the
 * shape the MODEL emits; it deliberately EXCLUDES the columns injected by the
 * workflow Code node / DB and never produced by the model:
 *   - `id`               — ULID generated client-side by A3.
 *   - `provider_id`      — FK injected per profiled provider.
 *   - `last_profiled_at` — NULL until the first successful profile (A3/A4 set it).
 *   - `profiler_run_id`  — the A3 run identifier, injected per run.
 *   - `created_at` / `updated_at` — DB defaults / trigger-managed.
 * `agent.site_recipes.selectors` is free `jsonb` (currently empty), so the new
 * nested shape needs NO migration.
 *
 * Unlike A1/A2 there is NO array envelope: A3 emits exactly ONE recipe per site
 * (agent.site_recipes is UNIQUE per provider), and `SiteRecipeSchema` is itself
 * an object — which already satisfies OpenAI Structured Outputs' "top-level must
 * be an object" rule. So this schema IS the SO root.
 *
 * CROSS-FIELD RULES — enforced DOWNSTREAM, not here (calques A2, whose non-empty
 * evidence_urls rule lives in validateAndFilter, NOT in the Zod contract). This
 * schema is purely structural; the rules below belong to validate-and-profile.ts:
 *
 *   1. VALIDITY: a recipe is 'active' ONLY if `title` is usable AND the variant
 *      dimension is usable — i.e. `variants.container`, `variants.price` and
 *      `variants.availability` are all present with a non-empty `selector`. If
 *      any is missing/degenerate → 'failed'. Never 'active' with gaps. (Replaces
 *      the old flat title/price/stock rule; analogous to A2's non-empty
 *      evidence_urls gate.)
 *   2. ATTRIBUTE: a FieldSelector with `source = 'attribute'` MUST carry a
 *      non-null `attribute_name`. Applies to ALL nine FieldSelector slots (the
 *      four product-level ones + the five inside `variants`). The structural
 *      contract allows null on purpose (so the model emits the honest null for
 *      text/json sources instead of fabricating a name); the conditional cut
 *      lives downstream.
 *   3. PRICE_HIGH ↔ MODE: `variants.price_high` is meaningful ONLY for
 *      `mode = 'aggregate-range'` (the AggregateOffer `highPrice`). In
 *      `mode = 'per-offer'` it MUST be null — each Offer has one exact price, so
 *      a non-null `price_high` is an inconsistent (malformed) recipe → 'failed'
 *      (reason `price_high_mode_mismatch`). The INVERSE is NOT enforced: an
 *      'aggregate-range' recipe that leaves `price_high` null stays 'active'.
 *
 * URL note (Zod v4 drift): `search_url_template` is a PLAIN `z.string()`, never
 * `.url()` — it is a template fragment ('?s=<query>'), not a URL, AND Zod v4's
 * z.toJSONSchema emits `"format":"uri"` for `.url()`, which OpenAI Structured
 * Outputs strict mode rejects with HTTP 400. See 02-sourcing-scout/schemas/README.md.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Enums (single source of truth — used by schema AND tests)
// ---------------------------------------------------------------------------

/** Extraction strategy for one field. Prefer 'json-ld' when the page exposes it. */
export const STRATEGY_VALUES = ['json-ld', 'css', 'xpath'] as const

/** Where to read the value from once the node is located. */
export const FIELD_SOURCE_VALUES = ['text', 'attribute', 'json'] as const

/** Per-field robustness self-assessment by the model. */
export const EXTRACTION_CONFIDENCE_VALUES = ['high', 'medium', 'low'] as const

/** How a storefront exposes per-size pricing in its Product JSON-LD. */
export const VARIANT_MODE_VALUES = ['per-offer', 'aggregate-range'] as const

/** Allowed values for `recipe_status`. Mirrors the 05-site-recipes CHECK. */
export const RECIPE_STATUS_VALUES = ['active', 'stale', 'failed'] as const

const StrategySchema = z.enum(STRATEGY_VALUES)
const FieldSourceSchema = z.enum(FIELD_SOURCE_VALUES)
const ExtractionConfidenceSchema = z.enum(EXTRACTION_CONFIDENCE_VALUES)
const VariantModeSchema = z.enum(VARIANT_MODE_VALUES)
const RecipeStatusSchema = z.enum(RECIPE_STATUS_VALUES)

// ---------------------------------------------------------------------------
// FieldSelector — how to extract ONE field from the product page
// ---------------------------------------------------------------------------

export const FieldSelectorSchema = z.object({
  strategy: StrategySchema.describe(
    'Extraction strategy. Prefer "json-ld" when the page ships a <script type="application/ld+json"> Product/Offer block; fall back to "css", then "xpath".',
  ),
  selector: z
    .string()
    .min(1)
    .describe(
      'The locator, interpreted per `strategy`: a CSS selector, an XPath expression, or a path into the JSON-LD object (e.g. "offers.price", "offers.0.lowPrice"). Non-empty.',
    ),
  source: FieldSourceSchema.describe(
    'Where to read the value once located: "text" = node text, "attribute" = the named attribute (see attribute_name), "json" = a value inside a JSON/JSON-LD blob.',
  ),
  attribute_name: z
    .string()
    .min(1)
    .nullable()
    .describe(
      'The attribute to read when source = "attribute" (e.g. "content", "data-price"). NULL for source "text"/"json". When source = "attribute" this MUST be non-null — enforced downstream, not in this structural contract.',
    ),
  cleanup_regex: z
    .string()
    .min(1)
    .nullable()
    .describe(
      'Optional regex to extract/clean the raw value (e.g. pull "100" from "100 ml", strip "$"/thousands separators from a price). NULL when the raw value is already clean. May also lift `ml` out of the title/URL when the site only shows size there.',
    ),
  extraction_confidence: ExtractionConfidenceSchema.describe(
    'How robust this selector is expected to be. "high" for a JSON-LD/Offer hit, lower for a brittle CSS/XPath path.',
  ),
})

// ---------------------------------------------------------------------------
// SiteRecipeSchema — the record A3 emits, maps to agent.site_recipes columns
// ---------------------------------------------------------------------------

export const SiteRecipeSchema = z.object({
  search_url_template: z
    .string()
    .min(1)
    .nullable()
    .describe(
      'How to build a search on this storefront, as a template with a <query> placeholder (e.g. "?s=<query>" or "/buscar?q=<query>"). PLAIN string, NOT a URL. NULL when the site has no navigable search pattern. Mirrors agent.site_recipes.search_url_template.',
    ),

  selectors: z
    .object({
      title: FieldSelectorSchema.describe(
        'REQUIRED. How to read the product title/name (e.g. JSON-LD "name"). This is the only mandatory PRODUCT-level selector.',
      ),
      brand: FieldSelectorSchema.nullable().describe(
        'OPTIONAL. How to read the brand. Shopify exposes a top-level JSON-LD "brand"; WooCommerce typically does not — NULL when the site does not expose it.',
      ),
      sku: FieldSelectorSchema.nullable().describe(
        'OPTIONAL. How to read the SKU / product code. WooCommerce exposes a JSON-LD "sku"; Shopify often leaves it null. NULL when the site exposes none.',
      ),
      currency: FieldSelectorSchema.nullable().describe(
        'OPTIONAL. How to read the ISO currency, usually on the offer node (Offer/AggregateOffer "priceCurrency"). NULL when not exposed — downstream defaults to MXN.',
      ),
      variants: z
        .object({
          mode: VariantModeSchema.describe(
            'How this storefront exposes per-size pricing in its Product JSON-LD. "per-offer" when `offers` is an ARRAY of Offer objects each carrying its own `price` (Shopify: one Offer per ml size). "aggregate-range" when `offers` is a single AggregateOffer with `lowPrice`/`highPrice` and no per-size price (WooCommerce). This drives the semantics of `container` and `price_high`.',
          ),
          container: FieldSelectorSchema.describe(
            'REQUIRED. Locator for the offers node, with DOUBLE SEMANTICS per `mode`: in "per-offer" it points at the ITERABLE ARRAY of Offer objects (e.g. JSON-LD path "offers") that A4 loops over, one product variant per element; in "aggregate-range" it points at the SINGLE AggregateOffer OBJECT (e.g. "offers.0") that A4 reads once.',
          ),
          ml: FieldSelectorSchema.nullable().describe(
            'OPTIONAL. How to read the size in ml PER VARIANT, as the site shows it. The size is frequently NOT a JSON-LD field but lives in the variant title or URL, so this is typically a "css"/"text" (or "json" on the variant url) selector with a `cleanup_regex` like "(\\\\d+)\\\\s*ml" to lift the number. NULL when the site exposes no per-variant size. A3 does NOT normalize decant vs full-bottle — that is A4/A5.',
          ),
          price: FieldSelectorSchema.describe(
            'REQUIRED. The price to read off the offers node: in "per-offer" the `price` of EACH Offer element (relative to `container`, e.g. "price"); in "aggregate-range" the AggregateOffer `lowPrice`. Mandatory for an active recipe.',
          ),
          price_high: FieldSelectorSchema.nullable().describe(
            'The AggregateOffer `highPrice` (top of the price range) — ONLY for mode "aggregate-range". MUST be NULL for "per-offer", where each Offer has a single exact price; a non-null price_high in per-offer is a malformed recipe and is failed downstream.',
          ),
          availability: FieldSelectorSchema.describe(
            'REQUIRED. How to read stock state PER VARIANT (per-offer) or for the aggregate (aggregate-range). schema.org availability appears as BOTH "http://schema.org/..." AND "https://schema.org/..." across these storefronts, so the cleanup_regex should match either scheme, e.g. "https?://schema\\\\.org/(InStock|OutOfStock)".',
          ),
        })
        .describe(
          'The variant/size dimension of the product (the ml axis of the decants business): how to read N sizes with N prices/stocks. Its shape is driven by `mode`. container/price/availability are mandatory for an active recipe; ml is null when no per-variant size is exposed; price_high is non-null ONLY in "aggregate-range".',
        ),
    })
    .describe(
      'The product-level selectors plus the `variants` dimension. title + variants{container,price,availability} are mandatory; brand/sku/currency and variants.ml/price_high are null when not exposed/not applicable. Mirrors agent.site_recipes.selectors (jsonb).',
    ),

  recipe_status: RecipeStatusSchema.describe(
    'Lifecycle status. A3 emits "active" (title + variants{container,price,availability} resolved well) or "failed" (no usable recipe could be built); "stale" is set later by A4 when a working recipe drifts. Mirrors the agent.site_recipes CHECK. A recipe is "active" ONLY if those mandatory selectors are present and well-formed and the price_high↔mode rule holds — never "active" with gaps (consistency enforced downstream).',
  ),
})

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Strategy = (typeof STRATEGY_VALUES)[number]
export type FieldSource = (typeof FIELD_SOURCE_VALUES)[number]
export type ExtractionConfidence = (typeof EXTRACTION_CONFIDENCE_VALUES)[number]
export type VariantMode = (typeof VARIANT_MODE_VALUES)[number]
export type RecipeStatus = (typeof RECIPE_STATUS_VALUES)[number]
export type FieldSelector = z.infer<typeof FieldSelectorSchema>
export type SiteRecipe = z.infer<typeof SiteRecipeSchema>
