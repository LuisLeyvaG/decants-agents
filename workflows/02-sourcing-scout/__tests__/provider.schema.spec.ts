/**
 * Unit tests for the Sourcing Scout Zod contract (v3 web-discovery shape).
 *
 * Covers structural validation for the single `ProviderSchema`: a valid
 * baseline, the nullable fields (source_id, whatsapp, instagram_handle,
 * trust_fulfillment, last_verified_at), the required fields (evidence_urls,
 * discovery_query, confidence, trust_quality), and the boundary rejections.
 * No DB, no network.
 */

import { ProviderSchema, type Provider } from '../schemas/provider.schema.js'

const makeProvider = (overrides: Partial<Provider> = {}): Provider => ({
  source: 'web',
  source_id: null,
  name: 'Leyva Scents',
  catalog_url: 'https://leyvascents.mx/catalog',
  whatsapp: '5512345678',
  instagram_handle: 'leyvascents',
  evidence_urls: ['https://leyvascents.mx/catalog', 'https://leyvascents.mx/returns'],
  discovery_query: 'decants premium CDMX envío',
  confidence: 0.82,
  trust_quality: 0.74,
  trust_fulfillment: null,
  last_verified_at: null,
  status: 'active',
  dedup_hash: 'deadbeef',
  ...overrides,
})

describe('ProviderSchema — valid', () => {
  it('accepts a fully populated baseline record', () => {
    expect(ProviderSchema.safeParse(makeProvider()).success).toBe(true)
  })

  it('accepts the nullable fields set to null', () => {
    const result = ProviderSchema.safeParse(
      makeProvider({
        source_id: null,
        whatsapp: null,
        instagram_handle: null,
        trust_fulfillment: null,
        last_verified_at: null,
      }),
    )
    expect(result.success).toBe(true)
  })

  it('accepts a numeric trust_fulfillment in [0,1]', () => {
    expect(ProviderSchema.safeParse(makeProvider({ trust_fulfillment: 0.5 })).success).toBe(true)
  })

  it('accepts an ISO last_verified_at', () => {
    expect(
      ProviderSchema.safeParse(makeProvider({ last_verified_at: '2026-05-31T12:00:00.000Z' }))
        .success,
    ).toBe(true)
  })

  it('accepts an empty evidence_urls array structurally (entry rule lives in validateAndFilter)', () => {
    // The Zod contract only enforces type (array of URLs); the "non-empty"
    // business rule is enforced downstream by validateAndFilter, not here.
    expect(ProviderSchema.safeParse(makeProvider({ evidence_urls: [] })).success).toBe(true)
  })

  it.each(['active', 'inactive', 'suspended'] as const)('accepts status %s', (status) => {
    expect(ProviderSchema.safeParse(makeProvider({ status })).success).toBe(true)
  })
})

describe('ProviderSchema — invalid', () => {
  it('rejects a source outside the enum (v3 is web-only)', () => {
    const result = ProviderSchema.safeParse(makeProvider({ source: 'maps' as never }))
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path)).toContainEqual(['source'])
    }
  })

  it('rejects a non-URL catalog_url', () => {
    expect(ProviderSchema.safeParse(makeProvider({ catalog_url: 'not-a-url' })).success).toBe(false)
  })

  it('rejects a null catalog_url (NOT NULL in v3)', () => {
    expect(ProviderSchema.safeParse(makeProvider({ catalog_url: null as never })).success).toBe(
      false,
    )
  })

  it('rejects a non-URL entry inside evidence_urls', () => {
    expect(
      ProviderSchema.safeParse(makeProvider({ evidence_urls: ['https://ok.mx', 'nope'] })).success,
    ).toBe(false)
  })

  it('rejects a missing/undefined discovery_query (required)', () => {
    expect(
      ProviderSchema.safeParse(makeProvider({ discovery_query: undefined as never })).success,
    ).toBe(false)
  })

  it('rejects an empty discovery_query', () => {
    expect(ProviderSchema.safeParse(makeProvider({ discovery_query: '' })).success).toBe(false)
  })

  it('rejects a null confidence (required)', () => {
    expect(ProviderSchema.safeParse(makeProvider({ confidence: null as never })).success).toBe(
      false,
    )
  })

  it('rejects a confidence outside [0,1]', () => {
    expect(ProviderSchema.safeParse(makeProvider({ confidence: 1.2 })).success).toBe(false)
    expect(ProviderSchema.safeParse(makeProvider({ confidence: -0.1 })).success).toBe(false)
  })

  it('rejects a null trust_quality (required)', () => {
    expect(ProviderSchema.safeParse(makeProvider({ trust_quality: null as never })).success).toBe(
      false,
    )
  })

  it('rejects a trust_quality outside [0,1]', () => {
    expect(ProviderSchema.safeParse(makeProvider({ trust_quality: 1.5 })).success).toBe(false)
  })

  it('rejects a trust_fulfillment outside [0,1] when not null', () => {
    expect(ProviderSchema.safeParse(makeProvider({ trust_fulfillment: 1.5 })).success).toBe(false)
  })

  it('rejects a status outside the enum', () => {
    expect(ProviderSchema.safeParse(makeProvider({ status: 'banned' as never })).success).toBe(
      false,
    )
  })

  it('rejects an empty name', () => {
    expect(ProviderSchema.safeParse(makeProvider({ name: '   ' })).success).toBe(false)
  })

  it('rejects an empty dedup_hash', () => {
    expect(ProviderSchema.safeParse(makeProvider({ dedup_hash: '' })).success).toBe(false)
  })

  it('rejects a non-ISO last_verified_at', () => {
    expect(
      ProviderSchema.safeParse(makeProvider({ last_verified_at: 'yesterday' as never })).success,
    ).toBe(false)
  })
})
