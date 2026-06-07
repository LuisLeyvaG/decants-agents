/**
 * Zod contract for Agente 3 (Site Profiler) — the per-provider scraping recipe.
 *
 * A single `SiteRecipeSchema` models ONE recipe: how to read a specific
 * storefront (how to search it, where title/price/stock/size/sku/currency live).
 * A3 produces it via LLM + Structured Outputs when a new provider is discovered
 * (or when A4 marks an existing recipe `stale`); A4 EXECUTES it in its daily
 * scrape with NO LLM in the critical path.
 *
 * Maps to `agent.site_recipes` (postgres/init/05-site-recipes.sql). This is the
 * shape the MODEL emits; it deliberately EXCLUDES the columns injected by the
 * workflow Code node / DB and never produced by the model:
 *   - `id`               — ULID generated client-side by A3.
 *   - `provider_id`      — FK injected per profiled provider.
 *   - `last_profiled_at` — NULL until the first successful profile (A3/A4 set it).
 *   - `profiler_run_id`  — the A3 run identifier, injected per run.
 *   - `created_at` / `updated_at` — DB defaults / trigger-managed.
 *
 * Unlike A1/A2 there is NO array envelope: A3 emits exactly ONE recipe per site
 * (agent.site_recipes is UNIQUE per provider), and `SiteRecipeSchema` is itself
 * an object — which already satisfies OpenAI Structured Outputs' "top-level must
 * be an object" rule. So this schema IS the SO root.
 *
 * CROSS-FIELD RULES — enforced DOWNSTREAM, not here (calques A2, whose non-empty
 * evidence_urls rule lives in validateAndFilter, NOT in the Zod contract). This
 * schema is purely structural; the rules below belong to the A3 mirror of
 * `02-sourcing-scout/validate-and-filter.ts` (container phase):
 *
 *   1. VALIDITY: a recipe is 'active' ONLY if title, price and stock are present
 *      and well-formed. If any of the three mandatory selectors is missing or
 *      degenerate → 'failed'. Never 'active' with gaps. (Analogous to A2's
 *      non-empty evidence_urls gate.)
 *   2. ATTRIBUTE: a FieldSelector with `source = 'attribute'` MUST carry a
 *      non-null `attribute_name`. The structural contract allows null on purpose
 *      (so the model emits the honest null for text/json sources instead of
 *      fabricating a name); the conditional cut lives downstream.
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

/** Allowed values for `recipe_status`. Mirrors the 05-site-recipes CHECK. */
export const RECIPE_STATUS_VALUES = ['active', 'stale', 'failed'] as const

const StrategySchema = z.enum(STRATEGY_VALUES)
const FieldSourceSchema = z.enum(FIELD_SOURCE_VALUES)
const ExtractionConfidenceSchema = z.enum(EXTRACTION_CONFIDENCE_VALUES)
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
      'The locator, interpreted per `strategy`: a CSS selector, an XPath expression, or a path into the JSON-LD object (e.g. "offers.price"). Non-empty.',
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
      'Optional regex to extract/clean the raw value (e.g. pull "100" from "100 ml", strip "$"/thousands separators from a price). NULL when the raw value is already clean. May also lift `ml` out of the title when the site only shows size there.',
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
        'REQUIRED. How to read the product title.',
      ),
      price: FieldSelectorSchema.describe(
        'REQUIRED. How to read the product price.',
      ),
      stock: FieldSelectorSchema.describe(
        'REQUIRED. How to read availability / stock state.',
      ),
      currency: FieldSelectorSchema.nullable().describe(
        'OPTIONAL. How to read the currency. NULL when the site does not expose it — downstream defaults to MXN.',
      ),
      ml: FieldSelectorSchema.nullable().describe(
        'OPTIONAL. How to read the size in ml AS THE SITE SHOWS IT (often lifted from the title via cleanup_regex). NULL when not exposed. A3 does NOT normalize decant vs full-bottle — that is A4/A5.',
      ),
      sku: FieldSelectorSchema.nullable().describe(
        'OPTIONAL. How to read the SKU / product code. NULL when the site does not expose one.',
      ),
    })
    .describe(
      'The six field selectors. title/price/stock are mandatory; currency/ml/sku are null when the site does not expose them. Mirrors agent.site_recipes.selectors (jsonb).',
    ),

  recipe_status: RecipeStatusSchema.describe(
    'Lifecycle status. A3 emits "active" (all three mandatory fields resolved well) or "failed" (no usable recipe could be built); "stale" is set later by A4 when a working recipe drifts. Mirrors the agent.site_recipes CHECK. A recipe is "active" ONLY if title, price and stock are present and well-formed — never "active" with gaps (consistency enforced downstream).',
  ),
})

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Strategy = (typeof STRATEGY_VALUES)[number]
export type FieldSource = (typeof FIELD_SOURCE_VALUES)[number]
export type ExtractionConfidence = (typeof EXTRACTION_CONFIDENCE_VALUES)[number]
export type RecipeStatus = (typeof RECIPE_STATUS_VALUES)[number]
export type FieldSelector = z.infer<typeof FieldSelectorSchema>
export type SiteRecipe = z.infer<typeof SiteRecipeSchema>
