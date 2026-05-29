/**
 * Zod contract for Agente 2 (Sourcing Scout).
 *
 * Two schemas model the two stages of a provider record:
 *
 *   1. `ProviderRawSchema` — what each source adapter emits AFTER normalizing
 *      its scraped payload but BEFORE scoring. Source-agnostic shape: Google
 *      Maps, MercadoLibre and Instagram adapters all converge here.
 *
 *   2. `ProviderScoredSchema` — the post-scoring record. It maps 1:1 to the
 *      columns of `agent.providers` (postgres/init/01-schema.sql) as a
 *      structural superset of that table's CHECK constraints.
 *
 * Mirrors `agent.providers` the same way Agente 1's `trend-signal.schema.ts`
 * mirrors `agent.trend_signals`. As there, `ProviderScoredSchema` intentionally
 * EXCLUDES the columns that are injected by the workflow Code node / DB and are
 * never produced by `scoreProvider`:
 *   - `id`         — ULID generated client-side by the workflow Code node.
 *   - `run_id`     — the run identifier, injected per run.
 *   - `created_at` / `updated_at` — DB defaults / trigger-managed.
 * Everything `scoreProvider` actually computes is present and maps 1:1 to a
 * real column. Persistence layers the four injected columns on top.
 *
 * SQL source of truth: the `agent.providers` DB had never been initialized at
 * the time of writing (no data volume), so `01-schema.sql` IS the authoritative
 * definition — its sole git revision includes `source_id text` (nullable), so
 * no migration is required for it.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Bounds / enums (single source of truth — used by schema AND tests)
// ---------------------------------------------------------------------------

/** Allowed values for `source`. Mirrors the DB CHECK constraint. */
export const SOURCE_VALUES = ['maps', 'mercadolibre', 'instagram'] as const

/** Allowed values for `status`. Mirrors the DB CHECK constraint. */
export const STATUS_VALUES = ['active', 'inactive', 'suspended'] as const

/** Allowed values for `tier`. Mirrors the DB CHECK constraint `tier IN (1,2,3)`. */
export const TIER_VALUES = [1, 2, 3] as const

/** Raw rating bounds, as reported by the source (e.g. Google Maps stars). */
export const RATING_MIN = 0
export const RATING_MAX = 5

/** All score dimensions and the composite live in [0, 1]. */
export const SCORE_MIN = 0
export const SCORE_MAX = 1

/**
 * Composite-score tier cutoffs. Inclusive lower bounds:
 *   composite >= TIER_1_THRESHOLD          → tier 1
 *   TIER_2_THRESHOLD <= composite < 0.85   → tier 2
 *   composite < TIER_2_THRESHOLD           → tier 3
 * Kept here as the single source of truth consumed by scoring.ts and the tests.
 */
export const TIER_1_THRESHOLD = 0.85
export const TIER_2_THRESHOLD = 0.7

// ---------------------------------------------------------------------------
// Reusable field schemas
// ---------------------------------------------------------------------------

/** A score dimension: a number in [0, 1], or null when not yet measured. */
const ScoreField = z.number().min(SCORE_MIN).max(SCORE_MAX).nullable()

const SourceSchema = z.enum(SOURCE_VALUES)
const StatusSchema = z.enum(STATUS_VALUES)

/** Tier is a numeric literal union (z.enum is string-only). */
const TierSchema = z.union([z.literal(1), z.literal(2), z.literal(3)])

// ---------------------------------------------------------------------------
// ProviderRawSchema — normalized source output, pre-scoring
// ---------------------------------------------------------------------------

export const ProviderRawSchema = z.object({
  source: SourceSchema.describe(
    'Which adapter produced this record: "maps" (Google Maps), "mercadolibre" or "instagram".',
  ),

  source_id: z
    .string()
    .min(1)
    .describe(
      'Stable identifier of the entity in its origin source (e.g. Google Maps place_id, MercadoLibre seller id, Instagram user id). Used for traceability, not for dedup.',
    ),

  name: z
    .string()
    .trim()
    .min(1)
    .describe('Display name of the provider / seller / store as shown by the source.'),

  whatsapp: z
    .string()
    .nullable()
    .describe(
      'Normalized phone number: digits only, with the +52 / 52 country prefix, spaces, dashes and parentheses stripped by the adapter. Null when the source exposes no phone.',
    ),

  instagram_handle: z
    .string()
    .nullable()
    .describe(
      'Instagram handle WITHOUT the leading "@". Null when the source exposes no Instagram account.',
    ),

  catalog_url: z
    .string()
    .nullable()
    .describe('URL of the provider catalog / storefront, when one exists. Null otherwise.'),

  rating: z
    .number()
    .min(RATING_MIN)
    .max(RATING_MAX)
    .nullable()
    .describe(
      'Raw average rating reported by the source, on a 0-5 star scale. Null when the source has no rating.',
    ),

  reviews_count: z
    .number()
    .int()
    .min(0)
    .nullable()
    .describe('Number of reviews / ratings backing the rating. Null when unknown.'),

  account_age_days: z
    .number()
    .int()
    .min(0)
    .nullable()
    .describe(
      'Age of the account / listing in days, used by the reputation antiquity factor. Null when the source does not expose a creation date.',
    ),

  detected_brands: z
    .array(z.string().trim().min(1))
    .describe(
      'Brand names detected in the provider catalog or bio. Free-form strings (aliases allowed, e.g. "MFK"); brandOverlap scoring resolves them against the reference list. May be empty.',
    ),

  has_physical_address: z
    .boolean()
    .describe('True when the source exposes a verifiable physical address / storefront location.'),

  refund_policy_explicit: z
    .boolean()
    .describe('True when the provider publishes an explicit refund / return policy.'),

  raw_signals: z
    // `unknown` is intentional: this is opaque per-source metadata (e.g. the
    // MercadoLibre seller JSON, Maps attributes) carried for auditing. It is
    // NOT the full HTML and is never indexed or scored — so it has no schema.
    .record(z.string(), z.unknown())
    .describe(
      'Opaque source-specific metadata kept for auditing (NOT the full HTML). Shape varies per source; never used in scoring.',
    ),
})

// ---------------------------------------------------------------------------
// ProviderScoredSchema — post-scoring, maps 1:1 to agent.providers columns
// ---------------------------------------------------------------------------

export const ProviderScoredSchema = z.object({
  source: SourceSchema.describe('Origin source. Mirrors agent.providers.source.'),

  source_id: z
    .string()
    .min(1)
    .describe(
      'Origin-source identifier. Mirrors agent.providers.source_id (DB allows NULL; the scorer always carries it through from the raw record).',
    ),

  name: z.string().trim().min(1).describe('Provider name. Mirrors agent.providers.name.'),

  whatsapp: z
    .string()
    .nullable()
    .describe('Normalized phone. Mirrors agent.providers.whatsapp.'),

  instagram_handle: z
    .string()
    .nullable()
    .describe('Instagram handle without "@". Mirrors agent.providers.instagram_handle.'),

  reputation_score: ScoreField.describe(
    'Reputation dimension in [0,1]. Mirrors agent.providers.reputation_score.',
  ),

  brand_overlap_score: ScoreField.describe(
    'Brand-overlap dimension in [0,1]. Mirrors agent.providers.brand_overlap_score.',
  ),

  response_speed_score: ScoreField.describe(
    'Response-speed dimension in [0,1]. NULL in v1 (Twilio deferred). Mirrors agent.providers.response_speed_score.',
  ),

  physical_presence_score: ScoreField.describe(
    'Physical-presence dimension in [0,1]. Mirrors agent.providers.physical_presence_score.',
  ),

  refund_policy_score: ScoreField.describe(
    'Refund-policy dimension in [0,1]. Mirrors agent.providers.refund_policy_score.',
  ),

  composite_score: z
    .number()
    .min(SCORE_MIN)
    .max(SCORE_MAX)
    .describe(
      'Weighted composite of the dimensions, in [0,1]. Always produced by the scorer (stricter than the DB, which allows NULL). Mirrors agent.providers.composite_score.',
    ),

  tier: TierSchema.describe(
    'Tier bucket 1|2|3 derived from composite_score. Mirrors agent.providers.tier.',
  ),

  avg_whatsapp_ms: z
    .number()
    .int()
    .min(0)
    .nullable()
    .describe(
      'Average WhatsApp response time in ms. NULL in v1 (Twilio deferred). Mirrors agent.providers.avg_whatsapp_ms.',
    ),

  last_verified_at: z
    .string()
    .datetime({ offset: true })
    .nullable()
    .describe(
      'ISO-8601 timestamp of the last availability verification. NULL in v1 (no verification step yet). Mirrors agent.providers.last_verified_at.',
    ),

  status: StatusSchema.describe(
    'Lifecycle status. Defaults to "active" at scoring time. Mirrors agent.providers.status.',
  ),

  catalog_url: z
    .string()
    .nullable()
    .describe('Catalog URL or null. Mirrors agent.providers.catalog_url.'),

  dedup_hash: z
    .string()
    .min(1)
    .describe(
      'Deterministic sha256 over the normalized phone + instagram handle. Backs the UNIQUE constraint on agent.providers.dedup_hash.',
    ),
})

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Source = (typeof SOURCE_VALUES)[number]
export type Status = (typeof STATUS_VALUES)[number]
export type Tier = (typeof TIER_VALUES)[number]
export type ProviderRaw = z.infer<typeof ProviderRawSchema>
export type ProviderScored = z.infer<typeof ProviderScoredSchema>
