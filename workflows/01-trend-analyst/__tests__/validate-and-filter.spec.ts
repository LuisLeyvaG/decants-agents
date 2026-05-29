/**
 * Unit tests for validateAndFilter.
 *
 * These tests cover the contract from raw LLM output → partitioned decision.
 * They do NOT touch Postgres — the function is pure and the n8n Code node
 * wraps it. If a test here would require a DB, it belongs in 5.3.7 smoke
 * tests instead, not this file.
 */

import {
  CONFIDENCE_THRESHOLD,
  DEMAND_SCORE_THRESHOLD,
  validateAndFilter,
} from '../validate-and-filter.js'
import type { TrendSignal } from '../schemas/trend-signal.schema.js'

const RUN_ID = '01HZX7K8M9N4P2Q5R6S7T8U9V0' // fake ULID for test isolation

const makeSignal = (overrides: Partial<TrendSignal> = {}): TrendSignal => ({
  brand: 'Maison Francis Kurkdjian',
  brand_line: null,
  fragrance_name: 'Baccarat Rouge 540 Extrait',
  demand_score: 85,
  velocity_7d: 12.4,
  sentiment: 'positive',
  sources: ['Reddit r/fragrance', 'Google Trends MX'],
  evidence_quotes: [
    'Repeatedly cited as the must-have niche in 2026 CDMX threads.',
  ],
  reasoning_summary:
    'BR540 Extrait remains the reference cultural-status pick for Mexican HNW buyers; the Extrait concentration sustains demand even as the EDP saturates the mass market.',
  confidence: 0.82,
  ...overrides,
})

describe('validateAndFilter — parse failures', () => {
  it('returns parse_failed when input is not an object', () => {
    const result = validateAndFilter('not an object', RUN_ID)
    expect(result.status).toBe('parse_failed')
    if (result.status === 'parse_failed') {
      expect(result.runId).toBe(RUN_ID)
      expect(result.error.issues.length).toBeGreaterThan(0)
    }
  })

  it('returns parse_failed (with ZodError) when signals key is missing', () => {
    const result = validateAndFilter({}, RUN_ID)
    expect(result.status).toBe('parse_failed')
    if (result.status === 'parse_failed') {
      const paths = result.error.issues.map((i) => i.path)
      expect(paths).toContainEqual(['signals'])
    }
  })

  it('returns parse_failed when a signal has invalid demand_score', () => {
    const result = validateAndFilter(
      { signals: [{ ...makeSignal(), demand_score: 999 }] },
      RUN_ID,
    )
    expect(result.status).toBe('parse_failed')
    if (result.status === 'parse_failed') {
      const paths = result.error.issues.map((i) => i.path)
      expect(paths).toContainEqual(['signals', 0, 'demand_score'])
    }
  })
})

describe('validateAndFilter — happy paths', () => {
  it('empty signals array returns ok with all 4 partitions empty', () => {
    const result = validateAndFilter({ signals: [] }, RUN_ID)
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.totalSignals).toBe(0)
      expect(result.known).toEqual([])
      expect(result.unknown).toEqual([])
      expect(result.excluded).toEqual([])
      expect(result.filteredOut).toEqual([])
    }
  })

  it('Bucket A signal passing all thresholds goes to known with bucket A', () => {
    const result = validateAndFilter({ signals: [makeSignal()] }, RUN_ID)
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.known).toHaveLength(1)
      expect(result.known[0]?.bucket).toBe('A')
      expect(result.known[0]?.signal.brand).toBe('Maison Francis Kurkdjian')
    }
  })

  it('Bucket D hype_only signal with high scores goes to known with bucket D', () => {
    const signal = makeSignal({
      brand: 'Dior',
      brand_line: null,
      fragrance_name: 'Sauvage Elixir',
      demand_score: 82,
      sentiment: 'hype_only',
      confidence: 0.93,
    })
    const result = validateAndFilter({ signals: [signal] }, RUN_ID)
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.known).toHaveLength(1)
      expect(result.known[0]?.bucket).toBe('D')
    }
  })

  it('Bucket A signal with low demand_score goes to filteredOut with reason demand_score_too_low', () => {
    const result = validateAndFilter(
      { signals: [makeSignal({ demand_score: 45 })] },
      RUN_ID,
    )
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.known).toHaveLength(0)
      expect(result.filteredOut).toHaveLength(1)
      expect(result.filteredOut[0]?.reason).toBe('demand_score_too_low')
      expect(result.filteredOut[0]?.bucket).toBe('A')
    }
  })

  it('Bucket A signal with low confidence goes to filteredOut with reason confidence_too_low', () => {
    const result = validateAndFilter(
      { signals: [makeSignal({ confidence: 0.5 })] },
      RUN_ID,
    )
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.filteredOut).toHaveLength(1)
      expect(result.filteredOut[0]?.reason).toBe('confidence_too_low')
    }
  })

  it('Bucket A signal with low demand AND low confidence goes to filteredOut with reason both_too_low', () => {
    const result = validateAndFilter(
      { signals: [makeSignal({ demand_score: 45, confidence: 0.5 })] },
      RUN_ID,
    )
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.filteredOut).toHaveLength(1)
      expect(result.filteredOut[0]?.reason).toBe('both_too_low')
    }
  })
})

describe('validateAndFilter — bucket lookup', () => {
  it('signal with unknown brand goes to unknown with knownBrand = false', () => {
    const result = validateAndFilter(
      { signals: [makeSignal({ brand: 'BrandXYZ-Not-In-Taxonomy' })] },
      RUN_ID,
    )
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.unknown).toHaveLength(1)
      expect(result.unknown[0]?.knownBrand).toBe(false)
    }
  })

  it('signal with known brand but unmapped brand_line goes to unknown with knownBrand = true', () => {
    const result = validateAndFilter(
      {
        signals: [
          makeSignal({ brand: 'Chanel', brand_line: 'Nonexistent Line' }),
        ],
      },
      RUN_ID,
    )
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.unknown).toHaveLength(1)
      expect(result.unknown[0]?.knownBrand).toBe(true)
    }
  })

  it('signal with Maison Alhambra (Bucket F) goes to excluded', () => {
    const result = validateAndFilter(
      { signals: [makeSignal({ brand: 'Maison Alhambra' })] },
      RUN_ID,
    )
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.excluded).toHaveLength(1)
      expect(result.excluded[0]?.bucket).toBe('F')
      expect(result.known).toHaveLength(0)
    }
  })

  it('Lattafa "Pride" with passing scores resolves to Bucket E and lands in known', () => {
    const result = validateAndFilter(
      {
        signals: [
          makeSignal({
            brand: 'Lattafa',
            brand_line: 'Pride',
            demand_score: 70,
            confidence: 0.85,
          }),
        ],
      },
      RUN_ID,
    )
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.known).toHaveLength(1)
      expect(result.known[0]?.bucket).toBe('E')
    }
  })
})

describe('validateAndFilter — partitioning', () => {
  it('partitions a mix of 5 signals correctly across all 4 buckets', () => {
    const signals = [
      // 1. Bucket A, passes thresholds → known
      makeSignal({ fragrance_name: 'BR540 Extrait' }),
      // 2. Bucket D, passes thresholds → known
      makeSignal({
        brand: 'Dior',
        fragrance_name: 'Sauvage Elixir',
        demand_score: 82,
        sentiment: 'hype_only',
        confidence: 0.9,
      }),
      // 3. Bucket A, low demand → filteredOut
      makeSignal({
        fragrance_name: 'BR540 EDP weak signal',
        demand_score: 30,
      }),
      // 4. Unknown brand → unknown
      makeSignal({ brand: 'Marca Inventada', fragrance_name: 'NoExiste' }),
      // 5. Bucket F clone → excluded
      makeSignal({
        brand: 'Maison Alhambra',
        fragrance_name: 'Layton Aevitas',
      }),
    ]
    const result = validateAndFilter({ signals }, RUN_ID)
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.totalSignals).toBe(5)
      expect(result.known).toHaveLength(2)
      expect(result.filteredOut).toHaveLength(1)
      expect(result.unknown).toHaveLength(1)
      expect(result.excluded).toHaveLength(1)
      // Sanity: bucket assignments
      const knownBuckets = result.known.map((k) => k.bucket).sort()
      expect(knownBuckets).toEqual(['A', 'D'])
    }
  })

  it('runId propagates verbatim in both success and parse_failed cases', () => {
    const okResult = validateAndFilter({ signals: [] }, RUN_ID)
    expect(okResult.runId).toBe(RUN_ID)

    const failResult = validateAndFilter(null, RUN_ID)
    expect(failResult.runId).toBe(RUN_ID)
    expect(failResult.status).toBe('parse_failed')
  })
})

describe('validateAndFilter — threshold constants exposed', () => {
  it('exports DEMAND_SCORE_THRESHOLD = 60 and CONFIDENCE_THRESHOLD = 0.7', () => {
    expect(DEMAND_SCORE_THRESHOLD).toBe(60)
    expect(CONFIDENCE_THRESHOLD).toBe(0.7)
  })
})
