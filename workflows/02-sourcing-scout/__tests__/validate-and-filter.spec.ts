/**
 * Unit tests for validateAndFilter (A2 — Sourcing Scout).
 *
 * Pure: from raw LLM output → partitioned decision (accepted / filteredOut /
 * rejected, + intra-run duplicates). No Postgres, no network. If a test here
 * would need a DB or a real API call, it belongs in the 2R.4 calibration smoke,
 * not this file. Mirrors 01-trend-analyst/__tests__/validate-and-filter.spec.ts.
 */

import {
  CONFIDENCE_THRESHOLD,
  TRUST_QUALITY_THRESHOLD,
  validateAndFilter,
} from '../validate-and-filter.js'
import type { ProviderRaw } from '../schemas/provider.schema.js'

const RUN_ID = '01HZX7K8M9N4P2Q5R6S7T8U9V0' // fake ULID for test isolation

const SHA256_HEX = /^[0-9a-f]{64}$/

/** A fully-valid raw provider (the 11-field SO shape). Override per test. */
const makeRawProvider = (overrides: Partial<ProviderRaw> = {}): ProviderRaw => ({
  source: 'web',
  source_id: null,
  name: 'Leyva Scents',
  catalog_url: 'https://leyvascents.mx/catalog',
  whatsapp: '5512345678',
  instagram_handle: 'leyvascents',
  evidence_urls: [
    'https://leyvascents.mx/about',
    'https://leyvascents.mx/shipping',
  ],
  discovery_query: 'decants niche mexico envio',
  confidence: 0.85,
  trust_quality: 0.75,
  status: 'active',
  ...overrides,
})

describe('validateAndFilter — envelope parse failures (whole-run abort)', () => {
  it('returns parse_failed when input is not an object', () => {
    const result = validateAndFilter('not an object', RUN_ID)
    expect(result.status).toBe('parse_failed')
    if (result.status === 'parse_failed') {
      expect(result.runId).toBe(RUN_ID)
      expect(result.error.issues.length).toBeGreaterThan(0)
    }
  })

  it('returns parse_failed when the providers key is missing', () => {
    const result = validateAndFilter({}, RUN_ID)
    expect(result.status).toBe('parse_failed')
    if (result.status === 'parse_failed') {
      const paths = result.error.issues.map((i) => i.path)
      expect(paths).toContainEqual(['providers'])
    }
  })

  it('returns parse_failed when providers is not an array', () => {
    const result = validateAndFilter({ providers: 'nope' }, RUN_ID)
    expect(result.status).toBe('parse_failed')
  })
})

describe('validateAndFilter — happy paths / accepted', () => {
  it('empty providers array returns ok with all partitions empty and zeroed stats', () => {
    const result = validateAndFilter({ providers: [] }, RUN_ID)
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.accepted).toEqual([])
      expect(result.filteredOut).toEqual([])
      expect(result.rejected).toEqual([])
      expect(result.duplicates).toEqual([])
      expect(result.stats).toEqual({
        totalCandidates: 0,
        acceptedCount: 0,
        filteredOutCount: 0,
        rejectedCount: 0,
        duplicatesDropped: 0,
      })
    }
  })

  it('a provider clearing gate + evidence + both thresholds is accepted with a dedup_hash injected', () => {
    const result = validateAndFilter(
      { providers: [makeRawProvider()] },
      RUN_ID,
    )
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.accepted).toHaveLength(1)
      const { provider } = result.accepted[0]!
      expect(provider.name).toBe('Leyva Scents')
      // dedup_hash IS this function's responsibility (it needed it to dedupe).
      expect(provider.dedup_hash).toMatch(SHA256_HEX)
      // trust_fulfillment / last_verified_at are NOT — the Code node injects
      // them. We deliberately do not assert on them here.
    }
  })
})

describe('validateAndFilter — filteredOut (below threshold, kept for calibration)', () => {
  it('trust_quality just below the cut → trust_quality_too_low', () => {
    const result = validateAndFilter(
      { providers: [makeRawProvider({ trust_quality: 0.59 })] },
      RUN_ID,
    )
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.accepted).toHaveLength(0)
      expect(result.filteredOut).toHaveLength(1)
      expect(result.filteredOut[0]!.reason).toBe('trust_quality_too_low')
      // raw scores are preserved for logging — not tossed.
      expect(result.filteredOut[0]!.provider.trust_quality).toBe(0.59)
      expect(result.filteredOut[0]!.provider.confidence).toBe(0.85)
    }
  })

  it('confidence just below the cut → confidence_too_low', () => {
    const result = validateAndFilter(
      { providers: [makeRawProvider({ confidence: 0.69 })] },
      RUN_ID,
    )
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.filteredOut).toHaveLength(1)
      expect(result.filteredOut[0]!.reason).toBe('confidence_too_low')
    }
  })

  it('both scores below the cut → both_too_low', () => {
    const result = validateAndFilter(
      { providers: [makeRawProvider({ trust_quality: 0.4, confidence: 0.5 })] },
      RUN_ID,
    )
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.filteredOut).toHaveLength(1)
      expect(result.filteredOut[0]!.reason).toBe('both_too_low')
    }
  })

  it('one high, one low (trust high, confidence low) → confidence_too_low', () => {
    const result = validateAndFilter(
      { providers: [makeRawProvider({ trust_quality: 0.95, confidence: 0.5 })] },
      RUN_ID,
    )
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.filteredOut[0]!.reason).toBe('confidence_too_low')
    }
  })
})

describe('validateAndFilter — rejected (hard-rule failures)', () => {
  it('missing catalog_url → schema_invalid, with the ZodError and raw preserved', () => {
    const { catalog_url, ...noCatalog } = makeRawProvider()
    const result = validateAndFilter({ providers: [noCatalog] }, RUN_ID)
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.rejected).toHaveLength(1)
      expect(result.rejected[0]!.reason).toBe('schema_invalid')
      expect(result.rejected[0]!.error).toBeDefined()
      expect(result.rejected[0]!.raw).toEqual(noCatalog)
      expect(result.accepted).toHaveLength(0)
    }
  })

  it('a score outside [0,1] → schema_invalid', () => {
    const result = validateAndFilter(
      { providers: [makeRawProvider({ confidence: 1.5 })] },
      RUN_ID,
    )
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.rejected).toHaveLength(1)
      expect(result.rejected[0]!.reason).toBe('schema_invalid')
    }
  })

  it('empty evidence_urls → evidence_empty (a code rule, NOT a schema error)', () => {
    const result = validateAndFilter(
      { providers: [makeRawProvider({ evidence_urls: [] })] },
      RUN_ID,
    )
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.rejected).toHaveLength(1)
      expect(result.rejected[0]!.reason).toBe('evidence_empty')
      // The schema allows [] on purpose, so there is no ZodError here.
      expect(result.rejected[0]!.error).toBeUndefined()
    }
  })

  it('a malformed shape (missing required name) → schema_invalid', () => {
    const { name, ...noName } = makeRawProvider()
    const result = validateAndFilter({ providers: [noName] }, RUN_ID)
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.rejected).toHaveLength(1)
      expect(result.rejected[0]!.reason).toBe('schema_invalid')
    }
  })

  it('one bad provider does not abort the run — good ones still partition', () => {
    const { catalog_url, ...bad } = makeRawProvider({ name: 'Broken Store' })
    const good = makeRawProvider({ name: 'Good Store' })
    const result = validateAndFilter({ providers: [bad, good] }, RUN_ID)
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.rejected).toHaveLength(1)
      expect(result.accepted).toHaveLength(1)
      expect(result.accepted[0]!.provider.name).toBe('Good Store')
    }
  })
})

describe('validateAndFilter — inclusive threshold borders', () => {
  it('trust_quality == 0.6 and confidence == 0.7 both PASS (>= is inclusive)', () => {
    const result = validateAndFilter(
      {
        providers: [
          makeRawProvider({
            trust_quality: TRUST_QUALITY_THRESHOLD,
            confidence: CONFIDENCE_THRESHOLD,
          }),
        ],
      },
      RUN_ID,
    )
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.accepted).toHaveLength(1)
      expect(result.filteredOut).toHaveLength(0)
    }
  })

  it('trust_quality exactly at the cut with passing confidence is accepted', () => {
    const result = validateAndFilter(
      {
        providers: [makeRawProvider({ trust_quality: 0.6, confidence: 0.9 })],
      },
      RUN_ID,
    )
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.accepted).toHaveLength(1)
    }
  })

  it('confidence exactly at the cut with passing trust_quality is accepted', () => {
    const result = validateAndFilter(
      {
        providers: [makeRawProvider({ trust_quality: 0.9, confidence: 0.7 })],
      },
      RUN_ID,
    )
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.accepted).toHaveLength(1)
    }
  })
})

describe('validateAndFilter — intra-run dedup (code safety net for §7.8)', () => {
  it('two accepted providers sharing a phone collapse to one; the other is a duplicate', () => {
    const a = makeRawProvider({
      name: 'Store A',
      catalog_url: 'https://store-a.mx/catalog',
      whatsapp: '5512345678',
      instagram_handle: 'store_a',
    })
    const b = makeRawProvider({
      name: 'Store B',
      catalog_url: 'https://store-b.mx/catalog',
      whatsapp: '+52 55 1234 5678', // same number, different format
      instagram_handle: 'store_b',
    })
    const result = validateAndFilter({ providers: [a, b] }, RUN_ID)
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.accepted).toHaveLength(1)
      expect(result.accepted[0]!.provider.name).toBe('Store A') // first wins
      expect(result.duplicates).toHaveLength(1)
      expect(result.duplicates[0]!.provider.name).toBe('Store B')
      expect(result.duplicates[0]!.reason).toBe('duplicate_in_run')
      expect(result.stats.duplicatesDropped).toBe(1)
      expect(result.stats.acceptedCount).toBe(1)
    }
  })

  it('distinct identifiers do not collide — both accepted', () => {
    const a = makeRawProvider({ whatsapp: '5512345678' })
    const b = makeRawProvider({
      name: 'Other',
      catalog_url: 'https://other.mx/catalog',
      whatsapp: '5599999999',
      instagram_handle: 'other',
    })
    const result = validateAndFilter({ providers: [a, b] }, RUN_ID)
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.accepted).toHaveLength(2)
      expect(result.duplicates).toHaveLength(0)
    }
  })
})

describe('validateAndFilter — partitioning & stats', () => {
  it('partitions a mix across accepted / filteredOut / rejected with correct stats', () => {
    const { catalog_url, ...broken } = makeRawProvider({ name: 'Broken' })
    const providers = [
      makeRawProvider({ name: 'Accepted', whatsapp: '5510000001' }),
      makeRawProvider({ name: 'Below cut', confidence: 0.5 }),
      broken,
      makeRawProvider({ name: 'No evidence', evidence_urls: [] }),
    ]
    const result = validateAndFilter({ providers }, RUN_ID)
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.stats).toEqual({
        totalCandidates: 4,
        acceptedCount: 1,
        filteredOutCount: 1,
        rejectedCount: 2,
        duplicatesDropped: 0,
      })
      expect(result.accepted[0]!.provider.name).toBe('Accepted')
      expect(result.filteredOut[0]!.provider.name).toBe('Below cut')
      const rejectReasons = result.rejected.map((r) => r.reason).sort()
      expect(rejectReasons).toEqual(['evidence_empty', 'schema_invalid'])
    }
  })

  it('raw scores are exposed across all kept categories for run_logs logging', () => {
    const providers = [
      makeRawProvider({ name: 'Acc', trust_quality: 0.8, confidence: 0.8 }),
      makeRawProvider({ name: 'Filt', trust_quality: 0.3, confidence: 0.9 }),
    ]
    const result = validateAndFilter({ providers }, RUN_ID)
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.accepted[0]!.provider.trust_quality).toBe(0.8)
      expect(result.accepted[0]!.provider.confidence).toBe(0.8)
      expect(result.accepted[0]!.provider.catalog_url).toContain('http')
      expect(result.filteredOut[0]!.provider.trust_quality).toBe(0.3)
      expect(result.filteredOut[0]!.provider.confidence).toBe(0.9)
    }
  })
})

describe('validateAndFilter — determinism & runId', () => {
  it('same input yields the same partition and the same hashes', () => {
    const input = {
      providers: [
        makeRawProvider({ name: 'A', whatsapp: '5510000001' }),
        makeRawProvider({ name: 'B', confidence: 0.5 }),
      ],
    }
    const a = validateAndFilter(input, RUN_ID)
    const b = validateAndFilter(input, RUN_ID)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('runId propagates verbatim in both ok and parse_failed cases', () => {
    expect(validateAndFilter({ providers: [] }, RUN_ID).runId).toBe(RUN_ID)
    const fail = validateAndFilter(null, RUN_ID)
    expect(fail.runId).toBe(RUN_ID)
    expect(fail.status).toBe('parse_failed')
  })
})

describe('validateAndFilter — threshold constants exposed', () => {
  it('exports TRUST_QUALITY_THRESHOLD = 0.6 and CONFIDENCE_THRESHOLD = 0.7', () => {
    expect(TRUST_QUALITY_THRESHOLD).toBe(0.6)
    expect(CONFIDENCE_THRESHOLD).toBe(0.7)
  })
})
