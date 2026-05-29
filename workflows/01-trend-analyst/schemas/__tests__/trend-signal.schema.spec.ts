/**
 * Unit tests for the Trend Analyst output schemas.
 *
 * These tests are the structural contract between the LLM output and the
 * `agent.trend_signals` table. They run on `safeParse` (never `parse`) so
 * we can assert both shape and the specific Zod issue paths on failure.
 */

import {
  CONFIDENCE_MAX,
  EVIDENCE_QUOTE_MAX_LEN,
  REASONING_SUMMARY_MAX_LEN,
  REASONING_SUMMARY_MIN_LEN,
  SENTIMENT_VALUES,
  TREND_SIGNALS_MAX_PER_RUN,
  TrendAnalystOutputSchema,
  TrendSignalSchema,
  type Sentiment,
  type TrendSignal,
} from '../trend-signal.schema'

const validSignal = (): TrendSignal => ({
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
})

describe('TrendSignalSchema — valid inputs', () => {
  it('accepts a fully valid signal', () => {
    const result = TrendSignalSchema.safeParse(validSignal())
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.brand).toBe('Maison Francis Kurkdjian')
      expect(result.data.demand_score).toBe(85)
    }
  })

  it('accepts negative velocity_7d (decline is a legitimate signal)', () => {
    const result = TrendSignalSchema.safeParse({
      ...validSignal(),
      velocity_7d: -23.7,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.velocity_7d).toBe(-23.7)
    }
  })

  it.each(SENTIMENT_VALUES)('accepts sentiment = %s', (sentiment) => {
    const result = TrendSignalSchema.safeParse({
      ...validSignal(),
      sentiment,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.sentiment).toBe(sentiment as Sentiment)
    }
  })

  it.each([
    ['lower bound', 0],
    ['upper bound', 100],
  ])('accepts demand_score = %s (%i)', (_label, score) => {
    const result = TrendSignalSchema.safeParse({
      ...validSignal(),
      demand_score: score,
    })
    expect(result.success).toBe(true)
  })

  it('trims surrounding whitespace on brand and fragrance_name', () => {
    const result = TrendSignalSchema.safeParse({
      ...validSignal(),
      brand: '  Creed  ',
      fragrance_name: '  Aventus  ',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.brand).toBe('Creed')
      expect(result.data.fragrance_name).toBe('Aventus')
    }
  })

  it('accepts brand_line = null (mainline fragrance)', () => {
    const result = TrendSignalSchema.safeParse(validSignal())
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.brand_line).toBeNull()
    }
  })

  it('accepts brand_line as a string (premium line within brand)', () => {
    const result = TrendSignalSchema.safeParse({
      ...validSignal(),
      brand: 'Chanel',
      brand_line: 'Les Exclusifs',
      fragrance_name: 'N°1957',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.brand_line).toBe('Les Exclusifs')
    }
  })

  it('accepts reasoning_summary at minimum length (50 chars)', () => {
    const minSummary = 'x'.repeat(REASONING_SUMMARY_MIN_LEN)
    const result = TrendSignalSchema.safeParse({
      ...validSignal(),
      reasoning_summary: minSummary,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.reasoning_summary).toHaveLength(
        REASONING_SUMMARY_MIN_LEN,
      )
    }
  })

  it('accepts reasoning_summary at maximum length (400 chars)', () => {
    const maxSummary = 'x'.repeat(REASONING_SUMMARY_MAX_LEN)
    const result = TrendSignalSchema.safeParse({
      ...validSignal(),
      reasoning_summary: maxSummary,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.reasoning_summary).toHaveLength(
        REASONING_SUMMARY_MAX_LEN,
      )
    }
  })
})

describe('TrendSignalSchema — invalid inputs', () => {
  it('rejects demand_score = -1', () => {
    const result = TrendSignalSchema.safeParse({
      ...validSignal(),
      demand_score: -1,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['demand_score'])
    }
  })

  it('rejects demand_score = 101', () => {
    const result = TrendSignalSchema.safeParse({
      ...validSignal(),
      demand_score: 101,
    })
    expect(result.success).toBe(false)
  })

  it('rejects non-integer demand_score (75.5)', () => {
    const result = TrendSignalSchema.safeParse({
      ...validSignal(),
      demand_score: 75.5,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['demand_score'])
    }
  })

  it('rejects confidence = 1.01 (above CONFIDENCE_MAX)', () => {
    const result = TrendSignalSchema.safeParse({
      ...validSignal(),
      confidence: CONFIDENCE_MAX + 0.01,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['confidence'])
    }
  })

  it('rejects sentiment = "negative" (not in enum)', () => {
    const result = TrendSignalSchema.safeParse({
      ...validSignal(),
      sentiment: 'negative',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['sentiment'])
    }
  })

  it('rejects empty brand (whitespace-only after trim)', () => {
    const result = TrendSignalSchema.safeParse({
      ...validSignal(),
      brand: '   ',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['brand'])
    }
  })

  it('rejects sources = [] (must have at least 1)', () => {
    const result = TrendSignalSchema.safeParse({
      ...validSignal(),
      sources: [],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['sources'])
    }
  })

  it('rejects evidence_quotes = [] (must have at least 1)', () => {
    const result = TrendSignalSchema.safeParse({
      ...validSignal(),
      evidence_quotes: [],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['evidence_quotes'])
    }
  })

  it('rejects an evidence_quote that exceeds EVIDENCE_QUOTE_MAX_LEN', () => {
    const tooLong = 'x'.repeat(EVIDENCE_QUOTE_MAX_LEN + 1)
    const result = TrendSignalSchema.safeParse({
      ...validSignal(),
      evidence_quotes: [tooLong],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual([
        'evidence_quotes',
        0,
      ])
    }
  })

  it('rejects missing brand_line key (must be explicitly present)', () => {
    const payload: Partial<TrendSignal> = validSignal()
    delete payload.brand_line
    const result = TrendSignalSchema.safeParse(payload)
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path)
      expect(paths).toContainEqual(['brand_line'])
    }
  })

  it('rejects brand_line as empty string', () => {
    const result = TrendSignalSchema.safeParse({
      ...validSignal(),
      brand_line: '',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['brand_line'])
    }
  })

  it('rejects brand_line as whitespace-only', () => {
    const result = TrendSignalSchema.safeParse({
      ...validSignal(),
      brand_line: '   ',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['brand_line'])
    }
  })

  it('rejects reasoning_summary below minimum length', () => {
    const tooShort = 'x'.repeat(REASONING_SUMMARY_MIN_LEN - 1)
    const result = TrendSignalSchema.safeParse({
      ...validSignal(),
      reasoning_summary: tooShort,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['reasoning_summary'])
    }
  })

  it('rejects reasoning_summary above maximum length', () => {
    const tooLong = 'x'.repeat(REASONING_SUMMARY_MAX_LEN + 1)
    const result = TrendSignalSchema.safeParse({
      ...validSignal(),
      reasoning_summary: tooLong,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['reasoning_summary'])
    }
  })

  it('rejects missing reasoning_summary key', () => {
    const payload: Partial<TrendSignal> = validSignal()
    delete payload.reasoning_summary
    const result = TrendSignalSchema.safeParse(payload)
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path)
      expect(paths).toContainEqual(['reasoning_summary'])
    }
  })
})

describe('TrendAnalystOutputSchema', () => {
  it('accepts an empty signals array (zero-finding run is valid)', () => {
    const result = TrendAnalystOutputSchema.safeParse({ signals: [] })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.signals).toEqual([])
    }
  })

  it('accepts an output with exactly 1 signal', () => {
    const result = TrendAnalystOutputSchema.safeParse({
      signals: [validSignal()],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.signals).toHaveLength(1)
    }
  })

  it(`rejects more than TREND_SIGNALS_MAX_PER_RUN (${TREND_SIGNALS_MAX_PER_RUN + 1}) signals`, () => {
    const signals = Array.from(
      { length: TREND_SIGNALS_MAX_PER_RUN + 1 },
      validSignal,
    )
    const result = TrendAnalystOutputSchema.safeParse({ signals })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['signals'])
    }
  })

  it('rejects an output missing the `signals` key', () => {
    const result = TrendAnalystOutputSchema.safeParse({})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['signals'])
    }
  })
})
