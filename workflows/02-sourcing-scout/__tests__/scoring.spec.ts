/**
 * Unit tests for the deterministic scoring layer.
 *
 * Exercises each dimension helper in isolation, the tier boundaries (the exact
 * knife-edges are tested against tierFromComposite, which is float-robust), the
 * weight-set invariants, and scoreProvider end-to-end. No DB, no network.
 */

import {
  brandOverlapScore,
  physicalPresenceScore,
  refundPolicyScore,
  reputationScore,
  scoreProvider,
  tierFromComposite,
  WEIGHTS_V1,
  WEIGHTS_V2,
  type ScoreOptions,
} from '../scripts/scoring.js'
import { TIER_1_THRESHOLD, TIER_2_THRESHOLD, type ProviderRaw } from '../schemas/provider.schema.js'

const ALL_REFERENCE_BRANDS = [
  'Maison Francis Kurkdjian',
  'Creed',
  'Amouage',
  'Parfums de Marly',
  'Louis Vuitton',
  'Yves Saint Laurent',
  'Dior',
  'Tom Ford',
  'Xerjoff',
  'Roja Parfums',
]

const makeRaw = (overrides: Partial<ProviderRaw> = {}): ProviderRaw => ({
  source: 'maps',
  source_id: 'place-1',
  name: 'Leyva Scents',
  whatsapp: '5512345678',
  instagram_handle: 'leyvascents',
  catalog_url: null,
  rating: 4.8,
  reviews_count: 500,
  account_age_days: 730,
  detected_brands: ['MFK', 'Creed'],
  has_physical_address: true,
  refund_policy_explicit: true,
  raw_signals: {},
  ...overrides,
})

// ---------------------------------------------------------------------------
// Weight invariants
// ---------------------------------------------------------------------------

describe('weight sets', () => {
  const sum = (w: Readonly<Record<string, number>>): number =>
    Object.values(w).reduce((a, b) => a + b, 0)

  it('WEIGHTS_V1 sums to exactly 1.0', () => {
    expect(Math.abs(sum(WEIGHTS_V1) - 1)).toBeLessThan(1e-9)
  })

  it('WEIGHTS_V2 sums to exactly 1.0', () => {
    expect(Math.abs(sum(WEIGHTS_V2) - 1)).toBeLessThan(1e-9)
  })
})

// ---------------------------------------------------------------------------
// tierFromComposite — exact boundaries
// ---------------------------------------------------------------------------

describe('tierFromComposite — boundaries', () => {
  it('composite exactly 0.85 → tier 1', () => {
    expect(tierFromComposite(TIER_1_THRESHOLD)).toBe(1)
    expect(tierFromComposite(0.85)).toBe(1)
  })

  it('composite exactly 0.70 → tier 2', () => {
    expect(tierFromComposite(TIER_2_THRESHOLD)).toBe(2)
    expect(tierFromComposite(0.7)).toBe(2)
  })

  it('composite 0.6999 → tier 3', () => {
    expect(tierFromComposite(0.6999)).toBe(3)
  })

  it('composite just below 0.85 → tier 2', () => {
    expect(tierFromComposite(0.8499)).toBe(2)
  })

  it.each([
    [0, 3],
    [0.7, 2],
    [0.849999, 2],
    [0.85, 1],
    [1, 1],
  ] as const)('composite %f → tier %i', (composite, expected) => {
    expect(tierFromComposite(composite)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// reputationScore
// ---------------------------------------------------------------------------

describe('reputationScore', () => {
  it('5★ with 10000 reviews and a mature account does not exceed 1.0', () => {
    const score = reputationScore(5, 10000, 3650)
    expect(score).toBeLessThanOrEqual(1)
    expect(score).toBeCloseTo(1, 10)
  })

  it('0 reviews does not crash and yields a finite score', () => {
    const score = reputationScore(5, 0, 0)
    expect(Number.isFinite(score)).toBe(true)
    expect(score).toBeCloseTo(0.6, 10) // rating-only contribution
  })

  it('all-null inputs yield 0 (no crash)', () => {
    expect(reputationScore(null, null, null)).toBe(0)
  })

  it('is monotonic in reviews: more reviews never lowers the score', () => {
    // Same rating + same age — only review volume differs.
    const fewer = reputationScore(4, 100, 365)
    const more = reputationScore(4, 500, 365)
    expect(more).toBeGreaterThanOrEqual(fewer)
  })

  it('stays within [0,1] across a range of inputs', () => {
    for (const [r, rev, age] of [
      [0, 0, 0],
      [2.5, 50, 100],
      [5, 5000, 730],
      [5, 50000, 5000],
    ] as const) {
      const s = reputationScore(r, rev, age)
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThanOrEqual(1)
    }
  })
})

// ---------------------------------------------------------------------------
// brandOverlapScore
// ---------------------------------------------------------------------------

describe('brandOverlapScore', () => {
  it('empty list → 0 (no crash)', () => {
    expect(brandOverlapScore([])).toBe(0)
  })

  it('all reference brands → 1.0', () => {
    expect(brandOverlapScore(ALL_REFERENCE_BRANDS)).toBeCloseTo(1, 10)
  })

  it('one brand → 0.1', () => {
    expect(brandOverlapScore(['Creed'])).toBeCloseTo(0.1, 10)
  })

  it('resolves the "MFK" alias to Maison Francis Kurkdjian', () => {
    expect(brandOverlapScore(['MFK'])).toBeCloseTo(0.1, 10)
    expect(brandOverlapScore(['Maison Francis Kurkdjian'])).toBeCloseTo(0.1, 10)
  })

  it('is case/punctuation-insensitive (YSL = Yves Saint Laurent)', () => {
    expect(brandOverlapScore(['ysl'])).toBeCloseTo(0.1, 10)
    expect(brandOverlapScore(['Saint-Laurent'])).toBeCloseTo(0.1, 10)
  })

  it('counts each reference brand at most once', () => {
    expect(brandOverlapScore(['MFK', 'Maison Francis Kurkdjian', 'mfk'])).toBeCloseTo(0.1, 10)
  })

  it('ignores unknown brands', () => {
    expect(brandOverlapScore(['Some Clone House', 'Another Dupe'])).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// boolean dimensions
// ---------------------------------------------------------------------------

describe('physicalPresenceScore / refundPolicyScore', () => {
  it('map booleans to 1.0 / 0.0', () => {
    expect(physicalPresenceScore(true)).toBe(1)
    expect(physicalPresenceScore(false)).toBe(0)
    expect(refundPolicyScore(true)).toBe(1)
    expect(refundPolicyScore(false)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// scoreProvider
// ---------------------------------------------------------------------------

const V1: ScoreOptions = { includeResponseSpeed: false }

describe('scoreProvider — v1 (includeResponseSpeed = false)', () => {
  it('nulls out response_speed_score', () => {
    const scored = scoreProvider(makeRaw(), V1)
    expect(scored.response_speed_score).toBeNull()
  })

  it('sets status=active and leaves the deferred columns null', () => {
    const scored = scoreProvider(makeRaw(), V1)
    expect(scored.status).toBe('active')
    expect(scored.avg_whatsapp_ms).toBeNull()
    expect(scored.last_verified_at).toBeNull()
  })

  it('computes a dedup_hash from the identifiers', () => {
    const scored = scoreProvider(makeRaw(), V1)
    expect(scored.dedup_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('carries source fields through verbatim', () => {
    const scored = scoreProvider(makeRaw({ source: 'instagram', source_id: 'ig-99' }), V1)
    expect(scored.source).toBe('instagram')
    expect(scored.source_id).toBe('ig-99')
  })

  it('a top provider (high reputation, full overlap, physical, refund) → tier 1', () => {
    const scored = scoreProvider(
      makeRaw({
        rating: 5,
        reviews_count: 5000,
        account_age_days: 1000,
        detected_brands: ALL_REFERENCE_BRANDS,
        has_physical_address: true,
        refund_policy_explicit: true,
      }),
      V1,
    )
    expect(scored.composite_score).toBeCloseTo(1, 6)
    expect(scored.tier).toBe(1)
  })

  it('a provider with brand_overlap = 0 scores low but does not crash', () => {
    const scored = scoreProvider(
      makeRaw({
        rating: 2,
        reviews_count: 0,
        account_age_days: 0,
        detected_brands: [],
        has_physical_address: false,
        refund_policy_explicit: false,
      }),
      V1,
    )
    expect(scored.brand_overlap_score).toBe(0)
    expect(scored.composite_score).toBeGreaterThanOrEqual(0)
    expect(scored.composite_score).toBeLessThan(TIER_2_THRESHOLD)
    expect(scored.tier).toBe(3)
  })

  it('composite_score stays within [0,1]', () => {
    const scored = scoreProvider(makeRaw(), V1)
    expect(scored.composite_score).toBeGreaterThanOrEqual(0)
    expect(scored.composite_score).toBeLessThanOrEqual(1)
  })
})

describe('scoreProvider — v2 hook (includeResponseSpeed = true)', () => {
  it('passes a provided responseSpeedScore through to the column', () => {
    const scored = scoreProvider(makeRaw(), {
      includeResponseSpeed: true,
      responseSpeedScore: 0.8,
    })
    expect(scored.response_speed_score).toBe(0.8)
  })

  it('leaves response_speed_score null when the v2 hook value is omitted', () => {
    const scored = scoreProvider(makeRaw(), { includeResponseSpeed: true })
    expect(scored.response_speed_score).toBeNull()
  })
})
