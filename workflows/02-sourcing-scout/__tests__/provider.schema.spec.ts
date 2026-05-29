/**
 * Unit tests for the Sourcing Scout Zod contract.
 *
 * Covers structural validation for both ProviderRawSchema and
 * ProviderScoredSchema — valid baselines plus the boundary rejections called
 * out in the sprint spec. No DB, no network.
 */

import {
  ProviderRawSchema,
  ProviderScoredSchema,
  type ProviderRaw,
  type ProviderScored,
} from '../schemas/provider.schema.js'

const makeRaw = (overrides: Partial<ProviderRaw> = {}): ProviderRaw => ({
  source: 'maps',
  source_id: 'ChIJ-place-id-123',
  name: 'Leyva Scents',
  whatsapp: '5512345678',
  instagram_handle: 'leyvascents',
  catalog_url: 'https://leyvascents.mx/catalog',
  rating: 4.7,
  reviews_count: 320,
  account_age_days: 540,
  detected_brands: ['MFK', 'Creed'],
  has_physical_address: true,
  refund_policy_explicit: true,
  raw_signals: { placeTypes: ['perfume_store'] },
  ...overrides,
})

const makeScored = (overrides: Partial<ProviderScored> = {}): ProviderScored => ({
  source: 'maps',
  source_id: 'ChIJ-place-id-123',
  name: 'Leyva Scents',
  whatsapp: '5512345678',
  instagram_handle: 'leyvascents',
  reputation_score: 0.82,
  brand_overlap_score: 0.2,
  response_speed_score: null,
  physical_presence_score: 1,
  refund_policy_score: 1,
  composite_score: 0.74,
  tier: 2,
  avg_whatsapp_ms: null,
  last_verified_at: null,
  status: 'active',
  catalog_url: 'https://leyvascents.mx/catalog',
  dedup_hash: 'deadbeef',
  ...overrides,
})

describe('ProviderRawSchema — valid', () => {
  it('accepts a fully populated record', () => {
    expect(ProviderRawSchema.safeParse(makeRaw()).success).toBe(true)
  })

  it('accepts nullable fields set to null', () => {
    const result = ProviderRawSchema.safeParse(
      makeRaw({
        whatsapp: null,
        instagram_handle: null,
        catalog_url: null,
        rating: null,
        reviews_count: null,
        account_age_days: null,
      }),
    )
    expect(result.success).toBe(true)
  })

  it('accepts an empty detected_brands array', () => {
    expect(ProviderRawSchema.safeParse(makeRaw({ detected_brands: [] })).success).toBe(true)
  })
})

describe('ProviderRawSchema — invalid', () => {
  it('rejects a source outside the enum', () => {
    const result = ProviderRawSchema.safeParse(makeRaw({ source: 'tiktok' as never }))
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path)).toContainEqual(['source'])
    }
  })

  it('rejects a rating above 5', () => {
    const result = ProviderRawSchema.safeParse(makeRaw({ rating: 5.5 }))
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path)).toContainEqual(['rating'])
    }
  })

  it('rejects a rating below 0', () => {
    expect(ProviderRawSchema.safeParse(makeRaw({ rating: -1 })).success).toBe(false)
  })

  it('rejects a negative reviews_count', () => {
    expect(ProviderRawSchema.safeParse(makeRaw({ reviews_count: -5 })).success).toBe(false)
  })

  it('rejects a non-integer reviews_count', () => {
    expect(ProviderRawSchema.safeParse(makeRaw({ reviews_count: 12.5 })).success).toBe(false)
  })

  it('rejects an empty name', () => {
    expect(ProviderRawSchema.safeParse(makeRaw({ name: '   ' })).success).toBe(false)
  })
})

describe('ProviderScoredSchema — valid', () => {
  it('accepts a baseline scored record', () => {
    expect(ProviderScoredSchema.safeParse(makeScored()).success).toBe(true)
  })

  it('accepts response_speed_score = null (Twilio deferred)', () => {
    expect(ProviderScoredSchema.safeParse(makeScored({ response_speed_score: null })).success).toBe(
      true,
    )
  })

  it('accepts a numeric response_speed_score in [0,1] (future v2)', () => {
    expect(ProviderScoredSchema.safeParse(makeScored({ response_speed_score: 0.5 })).success).toBe(
      true,
    )
  })

  it('accepts an ISO last_verified_at', () => {
    const result = ProviderScoredSchema.safeParse(
      makeScored({ last_verified_at: '2026-05-29T12:00:00.000Z' }),
    )
    expect(result.success).toBe(true)
  })

  it.each([1, 2, 3] as const)('accepts tier %i', (tier) => {
    expect(ProviderScoredSchema.safeParse(makeScored({ tier })).success).toBe(true)
  })
})

describe('ProviderScoredSchema — invalid', () => {
  it('rejects a score dimension above 1', () => {
    expect(ProviderScoredSchema.safeParse(makeScored({ reputation_score: 1.2 })).success).toBe(
      false,
    )
  })

  it('rejects a score dimension below 0', () => {
    expect(ProviderScoredSchema.safeParse(makeScored({ brand_overlap_score: -0.1 })).success).toBe(
      false,
    )
  })

  it('rejects a composite_score outside [0,1]', () => {
    expect(ProviderScoredSchema.safeParse(makeScored({ composite_score: 1.5 })).success).toBe(false)
  })

  it('rejects a tier outside 1|2|3', () => {
    expect(ProviderScoredSchema.safeParse(makeScored({ tier: 4 as never })).success).toBe(false)
  })

  it('rejects a status outside the enum', () => {
    expect(ProviderScoredSchema.safeParse(makeScored({ status: 'banned' as never })).success).toBe(
      false,
    )
  })

  it('rejects an empty dedup_hash', () => {
    expect(ProviderScoredSchema.safeParse(makeScored({ dedup_hash: '' })).success).toBe(false)
  })

  it('rejects a non-ISO last_verified_at', () => {
    expect(
      ProviderScoredSchema.safeParse(makeScored({ last_verified_at: 'yesterday' as never }))
        .success,
    ).toBe(false)
  })
})
