/**
 * Deterministic provider scoring for Agente 2 (Sourcing Scout).
 *
 * Pure, dependency-free (beyond Zod for output validation and the local dedup
 * helper). No network, no DB. Each dimension helper is independently testable
 * and returns a value in [0, 1]; `scoreProvider` combines them with a fixed
 * weight set into a composite, derives a tier, and validates the result against
 * `ProviderScoredSchema` before returning.
 *
 * Two weight sets exist:
 *   - WEIGHTS_V1 (default): no response-speed signal (Twilio deferred). Its
 *     four weights already sum to 1.0.
 *   - WEIGHTS_V2: includes response-speed, for the future Twilio-backed v2.
 *
 * The `includeResponseSpeed` flag selects the set. In v1 it stays false, the
 * response_speed_score column is NULL, and response speed never enters the
 * composite.
 */

import {
  ProviderScoredSchema,
  TIER_1_THRESHOLD,
  TIER_2_THRESHOLD,
  type ProviderRaw,
  type ProviderScored,
  type Tier,
} from '../schemas/provider.schema.js'
import { computeDedupHash } from './dedup.js'

// ---------------------------------------------------------------------------
// Reference brands + aliasing
// ---------------------------------------------------------------------------

/**
 * The premium houses whose presence in a provider catalog signals brand fit.
 * Each entry carries the aliases a source might emit; matching is
 * case/diacritic/punctuation-insensitive (see `normalizeBrandToken`). "MFK"
 * and "Maison Francis Kurkdjian" both resolve to the same reference brand.
 *
 * No taxonomy.ts existed for Agente 2 at the time of writing, so this is the
 * single source of truth for the reference list (distinct from Agente 1's
 * TAXONOMY, which serves a different purpose — bucket classification).
 */
export const REFERENCE_BRANDS: ReadonlyArray<{
  readonly canonical: string
  readonly aliases: ReadonlyArray<string>
}> = [
  { canonical: 'Maison Francis Kurkdjian', aliases: ['MFK', 'Maison Francis Kurkdjian', 'Francis Kurkdjian'] },
  { canonical: 'Creed', aliases: ['Creed'] },
  { canonical: 'Amouage', aliases: ['Amouage'] },
  { canonical: 'Parfums de Marly', aliases: ['PdM', 'Parfums de Marly', 'Marly'] },
  { canonical: 'Louis Vuitton', aliases: ['LV', 'Louis Vuitton'] },
  { canonical: 'Yves Saint Laurent', aliases: ['YSL', 'Yves Saint Laurent', 'Saint Laurent'] },
  { canonical: 'Dior', aliases: ['Dior', 'Christian Dior'] },
  { canonical: 'Tom Ford', aliases: ['Tom Ford', 'TF'] },
  { canonical: 'Xerjoff', aliases: ['Xerjoff'] },
  { canonical: 'Roja Parfums', aliases: ['Roja Parfums', 'Roja', 'Roja Dove'] },
] as const

/**
 * Normalize a brand token for comparison: lowercase, strip diacritics, drop
 * punctuation, collapse internal whitespace, trim. So "Saint-Laurent",
 * "saint laurent" and "Saint  Laurent" all collapse to "saint laurent".
 */
function normalizeBrandToken(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // U+0300–U+036F combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ') // punctuation → space
    .replace(/\s+/g, ' ')
    .trim()
}

// Precomputed alias → reference-index lookup, built once at module load.
const ALIAS_LOOKUP: ReadonlyMap<string, number> = (() => {
  const map = new Map<string, number>()
  REFERENCE_BRANDS.forEach((brand, index) => {
    for (const alias of brand.aliases) {
      map.set(normalizeBrandToken(alias), index)
    }
  })
  return map
})()

// ---------------------------------------------------------------------------
// Reputation sub-factor tuning
// ---------------------------------------------------------------------------

const RATING_MAX = 5

/**
 * Review count at which the volume sub-score saturates to 1.0. Logarithmic
 * saturation means 500 vs 5000 reviews barely differ near the top, so a
 * mega-seller does not crowd out a strong specialist.
 */
export const REVIEW_SATURATION = 1000

/** Account age (days) at which the antiquity sub-score saturates to 1.0 (~2y). */
export const ACCOUNT_AGE_SATURATION_DAYS = 730

/**
 * Internal weights of the three reputation sub-factors. Sum to 1.0 so that the
 * combined reputation score stays in [0, 1] (each sub-factor is itself capped
 * at 1.0).
 */
export const REPUTATION_WEIGHTS = {
  rating: 0.6,
  reviews: 0.25,
  age: 0.15,
} as const

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x))
}

// ---------------------------------------------------------------------------
// Dimension helpers — each pure, each → [0, 1]
// ---------------------------------------------------------------------------

/**
 * Reputation = weighted blend of:
 *   - ratingNorm  = rating / 5                                  (0 if null)
 *   - reviewNorm  = ln(1 + reviews) / ln(1 + REVIEW_SATURATION) (0 if null/≤0, capped at 1)
 *   - ageNorm     = accountAgeDays / ACCOUNT_AGE_SATURATION_DAYS(0 if null/≤0, capped at 1)
 *
 * Combined with REPUTATION_WEIGHTS. Because every sub-factor is in [0, 1] and
 * the weights sum to 1.0, the result is in [0, 1] — a 5★/10000-review account
 * cannot exceed 1.0. A null sub-factor contributes 0 (does not crash).
 *
 * Monotonic in reviews: ln is increasing, so more reviews (same rating/age)
 * never lowers the score.
 */
export function reputationScore(
  rating: number | null,
  reviewsCount: number | null,
  accountAgeDays: number | null,
): number {
  const ratingNorm = rating === null ? 0 : clamp01(rating / RATING_MAX)

  const reviewNorm =
    reviewsCount === null || reviewsCount <= 0
      ? 0
      : clamp01(Math.log1p(reviewsCount) / Math.log1p(REVIEW_SATURATION))

  const ageNorm =
    accountAgeDays === null || accountAgeDays <= 0
      ? 0
      : clamp01(accountAgeDays / ACCOUNT_AGE_SATURATION_DAYS)

  return (
    REPUTATION_WEIGHTS.rating * ratingNorm +
    REPUTATION_WEIGHTS.reviews * reviewNorm +
    REPUTATION_WEIGHTS.age * ageNorm
  )
}

/**
 * Brand overlap = fraction of REFERENCE_BRANDS detected in the catalog/bio,
 * resolved through the alias table (case/diacritic/punctuation-insensitive).
 * Each reference brand counts at most once; the result is in [0, 1]. An empty
 * `detectedBrands` array yields 0 without crashing.
 */
export function brandOverlapScore(detectedBrands: string[]): number {
  const matched = new Set<number>()
  for (const raw of detectedBrands) {
    const index = ALIAS_LOOKUP.get(normalizeBrandToken(raw))
    if (index !== undefined) {
      matched.add(index)
    }
  }
  return matched.size / REFERENCE_BRANDS.length
}

/** Physical presence: 1.0 if the provider exposes a physical address, else 0.0. */
export function physicalPresenceScore(hasPhysicalAddress: boolean): number {
  return hasPhysicalAddress ? 1 : 0
}

/** Refund policy: 1.0 if the provider publishes an explicit policy, else 0.0. */
export function refundPolicyScore(refundPolicyExplicit: boolean): number {
  return refundPolicyExplicit ? 1 : 0
}

// ---------------------------------------------------------------------------
// Composite weight sets
// ---------------------------------------------------------------------------

/** v1 weights — no response-speed signal. Four weights summing to 1.0. */
export const WEIGHTS_V1 = {
  reputation: 0.375,
  brandOverlap: 0.3125,
  physicalPresence: 0.1875,
  refundPolicy: 0.125,
} as const

/** v2 weights — includes response-speed (future Twilio integration). Sum 1.0. */
export const WEIGHTS_V2 = {
  reputation: 0.3,
  brandOverlap: 0.25,
  responseSpeed: 0.2,
  physicalPresence: 0.15,
  refundPolicy: 0.1,
} as const

/**
 * Runtime guard against future typos in the weight tables: each set MUST sum to
 * exactly 1.0 (within float tolerance). Runs at module load so a bad edit fails
 * fast on import rather than silently skewing every composite.
 */
function assertWeightsSumToOne(
  name: string,
  weights: Readonly<Record<string, number>>,
): void {
  const sum = Object.values(weights).reduce((a, b) => a + b, 0)
  if (Math.abs(sum - 1) > 1e-9) {
    throw new Error(`${name} weights must sum to 1.0, got ${sum}`)
  }
}

assertWeightsSumToOne('WEIGHTS_V1', WEIGHTS_V1)
assertWeightsSumToOne('WEIGHTS_V2', WEIGHTS_V2)

// ---------------------------------------------------------------------------
// Tier derivation
// ---------------------------------------------------------------------------

/**
 * Map a composite score to its tier. Inclusive lower bounds:
 *   composite >= 0.85 → 1, >= 0.70 → 2, else 3.
 */
export function tierFromComposite(composite: number): Tier {
  if (composite >= TIER_1_THRESHOLD) return 1
  if (composite >= TIER_2_THRESHOLD) return 2
  return 3
}

// ---------------------------------------------------------------------------
// scoreProvider
// ---------------------------------------------------------------------------

export interface ScoreOptions {
  /**
   * When false (v1 default): response speed is excluded, response_speed_score
   * is NULL, and WEIGHTS_V1 (which already sums to 1.0) drives the composite.
   * When true (future v2): WEIGHTS_V2 is used and `responseSpeedScore` feeds the
   * composite + the output column.
   */
  readonly includeResponseSpeed: boolean

  /**
   * v2 hook: the response-speed sub-score in [0, 1], typically derived from
   * Twilio WhatsApp latency. Ignored when `includeResponseSpeed` is false.
   * Until Twilio lands, callers passing `includeResponseSpeed: true` may leave
   * this null, in which case it contributes 0 to the composite.
   */
  readonly responseSpeedScore?: number | null
}

/**
 * Score a normalized raw provider into a `ProviderScored` record ready to
 * persist into `agent.providers`.
 *
 * Sets `status = 'active'`, computes `dedup_hash` via `computeDedupHash`, leaves
 * the deferred columns (`avg_whatsapp_ms`, `last_verified_at`) null, and
 * validates the output with `ProviderScoredSchema.parse` (not safeParse): a
 * validation failure here is a bug in the scorer and must throw, not be
 * swallowed.
 */
export function scoreProvider(
  raw: ProviderRaw,
  opts: ScoreOptions,
): ProviderScored {
  const reputation = reputationScore(
    raw.rating,
    raw.reviews_count,
    raw.account_age_days,
  )
  const brandOverlap = brandOverlapScore(raw.detected_brands)
  const physicalPresence = physicalPresenceScore(raw.has_physical_address)
  const refundPolicy = refundPolicyScore(raw.refund_policy_explicit)

  let composite: number
  let responseSpeedOut: number | null

  if (opts.includeResponseSpeed) {
    const responseSpeed = opts.responseSpeedScore ?? 0
    composite =
      WEIGHTS_V2.reputation * reputation +
      WEIGHTS_V2.brandOverlap * brandOverlap +
      WEIGHTS_V2.responseSpeed * responseSpeed +
      WEIGHTS_V2.physicalPresence * physicalPresence +
      WEIGHTS_V2.refundPolicy * refundPolicy
    responseSpeedOut = opts.responseSpeedScore ?? null
  } else {
    composite =
      WEIGHTS_V1.reputation * reputation +
      WEIGHTS_V1.brandOverlap * brandOverlap +
      WEIGHTS_V1.physicalPresence * physicalPresence +
      WEIGHTS_V1.refundPolicy * refundPolicy
    responseSpeedOut = null
  }

  const scored: ProviderScored = {
    source: raw.source,
    source_id: raw.source_id,
    name: raw.name,
    whatsapp: raw.whatsapp,
    instagram_handle: raw.instagram_handle,
    reputation_score: reputation,
    brand_overlap_score: brandOverlap,
    response_speed_score: responseSpeedOut,
    physical_presence_score: physicalPresence,
    refund_policy_score: refundPolicy,
    composite_score: composite,
    tier: tierFromComposite(composite),
    avg_whatsapp_ms: null,
    last_verified_at: null,
    status: 'active',
    catalog_url: raw.catalog_url,
    dedup_hash: computeDedupHash(raw.whatsapp, raw.instagram_handle),
  }

  return ProviderScoredSchema.parse(scored)
}
