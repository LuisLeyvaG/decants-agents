/**
 * Zod contract for the output of Agente 1 (Trend Analyst).
 *
 * The LLM is asked to return a list of demand signals for fragrances in the
 * Mexican HNW market. Its raw output MUST be validated by these schemas
 * before any Code node touches the `agent.trend_signals` table — failed
 * validation = the LLM hallucinated structure and the run is aborted.
 *
 * Mirrors `agent.trend_signals` (postgres/init/01-schema.sql) as a structural
 * superset of its CHECK constraints. This schema is intentionally stricter
 * than the DB column nullability: fields that the DB allows NULL on
 * (`velocity_7d`, `sources`, `evidence_quotes`) are required here, because
 * the LLM is expected to always produce them. Persistence converts as needed.
 *
 * The schema does NOT include:
 *   - `id`, `run_id`, `created_at` — injected by the workflow Code node / DB,
 *     never by the LLM.
 *   - `bucket` — resolved downstream by the Code node via lookup against the
 *     canonical brand taxonomy (Buckets A-F). The LLM emits brand + brand_line;
 *     classification is the responsibility of the workflow, not the model.
 *   - Semantic filtering (`demand_score >= 60`, `confidence >= 0.7`) —
 *     that's the responsibility of the system prompt + the post-validation
 *     Code node, not the structural contract.
 *
 * The root output is an object (`{ signals: [...] }`) and not a bare array
 * because OpenAI Structured Outputs requires a top-level object.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Bounds / constants (single source of truth — used by schema AND tests)
// ---------------------------------------------------------------------------

/** Allowed values for `sentiment`. Mirrors the DB CHECK constraint. */
export const SENTIMENT_VALUES = ['positive', 'mixed', 'hype_only'] as const

export const DEMAND_SCORE_MIN = 0
export const DEMAND_SCORE_MAX = 100

export const CONFIDENCE_MIN = 0
export const CONFIDENCE_MAX = 1

/**
 * Sanity bounds for `velocity_7d`. Enforced at the app layer only — the DB
 * column is an unconstrained `numeric`. Allows both growth (positive) and
 * decline (negative); a falling trend is itself a legitimate signal.
 */
export const VELOCITY_7D_MIN = -100
export const VELOCITY_7D_MAX = 100

/** Per-quote length cap — keeps the LLM from dumping full articles. */
export const EVIDENCE_QUOTE_MAX_LEN = 500

/**
 * `brand_line` is short-form. Examples: "Les Exclusifs", "Private Blend",
 * "La Collection Privée", "Hermessence", "Le Vestiaire des Parfums".
 */
export const BRAND_LINE_MAX_LEN = 80

/**
 * `reasoning_summary` floor forces synthesis rather than a label. 50 chars
 * roughly matches "Riding the 2026 oud revival; sustained TikTok pickup."
 */
export const REASONING_SUMMARY_MIN_LEN = 50
export const REASONING_SUMMARY_MAX_LEN = 400

/** A signal without any evidence is hallucination, not a signal. */
export const SOURCES_MIN_COUNT = 1
export const EVIDENCE_QUOTES_MIN_COUNT = 1

/** Hard cap on signals per run — guards against runaway LLM outputs. */
export const TREND_SIGNALS_MAX_PER_RUN = 30

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * A single demand signal for one fragrance.
 *
 * Field descriptions are surfaced verbatim in the JSON Schema sent to OpenAI
 * Structured Outputs, so they double as instructions to the model. Keep them
 * in English, concrete, and short.
 */
export const TrendSignalSchema = z.object({
  brand: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .describe(
      'Perfume house / brand name (e.g. "Maison Francis Kurkdjian"). No abbreviations.',
    ),

  brand_line: z
    .string()
    .trim()
    .min(1)
    .max(BRAND_LINE_MAX_LEN)
    .nullable()
    .describe(
      'Specific premium line within the brand when applicable (e.g. "Les Exclusifs" for Chanel, "La Collection Privée" for Dior, "Private Blend" for Tom Ford, "Hermessence" for Hermès, "Le Vestiaire des Parfums" for YSL). Use null when the brand has no internal line distinction OR when the fragrance is from the mainline. Examples: Chanel Bleu de Chanel → null; Chanel N°1957 → "Les Exclusifs". Dior Sauvage → null; Dior Gris Dior → "La Collection Privée". Be explicit: an omitted key is a validation error — emit null deliberately when there is no line.',
    ),

  fragrance_name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe(
      'Commercial fragrance name as listed by the house (e.g. "Baccarat Rouge 540 Extrait"). Include concentration / flanker suffix when applicable.',
    ),

  demand_score: z
    .number()
    .int()
    .min(DEMAND_SCORE_MIN)
    .max(DEMAND_SCORE_MAX)
    .describe(
      'Integer 0-100 estimating relative demand among Mexican high-net-worth fragrance buyers. 0 = ignored, 100 = unmissable cultural moment.',
    ),

  velocity_7d: z
    .number()
    .finite()
    .min(VELOCITY_7D_MIN)
    .max(VELOCITY_7D_MAX)
    .describe(
      'Percentage change in interest over the last 7 days. Negative values indicate decline — emit them when the trend is fading.',
    ),

  sentiment: z
    .enum(SENTIMENT_VALUES)
    .describe(
      'Aggregate community sentiment. "positive" = genuinely loved, "mixed" = divisive but discussed, "hype_only" = trending without substance.',
    ),

  sources: z
    .array(z.string().trim().min(1).max(200))
    .min(SOURCES_MIN_COUNT)
    .max(10)
    .describe(
      'Free-text identifiers of the sources consulted (e.g. "Reddit r/fragrance", "Google Trends MX", "Fragrantica reviews"). Not URLs.',
    ),

  evidence_quotes: z
    .array(z.string().trim().min(1).max(EVIDENCE_QUOTE_MAX_LEN))
    .min(EVIDENCE_QUOTES_MIN_COUNT)
    .max(10)
    .describe(
      'Short verbatim quotes or paraphrases that justify the demand_score. Each item is one quote — do not concatenate.',
    ),

  reasoning_summary: z
    .string()
    .trim()
    .min(REASONING_SUMMARY_MIN_LEN)
    .max(REASONING_SUMMARY_MAX_LEN)
    .describe(
      'One- to two-sentence analytical synthesis of why this signal matters right now. Distinct from evidence_quotes (which are verbatim citations from sources): this is your takeaway interpreting those quotes against current 2026 market trends. Example: "Sustained TikTok pickup in Mexico CDMX paired with the 2026 oud revival; Khamrah is the gateway SKU pulling first-time buyers into Arab perfumery." Avoid generic phrases like "trending" or "popular" — name the mechanism.',
    ),

  confidence: z
    .number()
    .finite()
    .min(CONFIDENCE_MIN)
    .max(CONFIDENCE_MAX)
    .describe(
      'Model self-reported confidence in this signal, in [0, 1]. Anything below 0.7 will be dropped downstream — be honest.',
    ),
})

/**
 * Root contract returned by the Trend Analyst for a single run.
 *
 * An empty `signals` array is valid: a run that legitimately found nothing
 * interesting in the last window is a real outcome, not an error. The Code
 * node downstream records it as `status='succeeded'` with `signals_processed=0`.
 */
export const TrendAnalystOutputSchema = z.object({
  signals: z
    .array(TrendSignalSchema)
    .max(TREND_SIGNALS_MAX_PER_RUN)
    .describe(
      `Up to ${TREND_SIGNALS_MAX_PER_RUN} trend signals discovered during this run. May be empty.`,
    ),
})

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Sentiment = (typeof SENTIMENT_VALUES)[number]
export type TrendSignal = z.infer<typeof TrendSignalSchema>
export type TrendAnalystOutput = z.infer<typeof TrendAnalystOutputSchema>
