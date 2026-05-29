/**
 * validate-and-filter — pure transformation from raw LLM output to a
 * structured decision about what to persist.
 *
 * Pipeline:
 *   1. Zod-parse the LLM output. Failure here = aborted run.
 *   2. For each signal, resolve its (brand, brand_line) bucket.
 *   3. Partition signals into 4 buckets by destination:
 *        - known      → INSERT into agent.trend_signals with resolved bucket.
 *        - unknown    → UPSERT into agent.unknown_brand_candidates (loop).
 *        - excluded   → log only (Bucket F = clones / mass; should be rare
 *                       since the system prompt forbids them, but we trap
 *                       any leak here).
 *        - filteredOut → log only (passed parse + lookup but below the
 *                        semantic thresholds demand_score >= 60 and
 *                        confidence >= 0.7).
 *   4. Return the structured decision. The workflow Code node executes the
 *      SQL based on it.
 *
 * This function is intentionally side-effect-free so it is unit-testable
 * without spinning up Postgres or n8n. The n8n Code node wraps it.
 */

import { z } from 'zod'
import {
  TrendAnalystOutputSchema,
  type TrendSignal,
} from './schemas/trend-signal.schema.js'
import { resolveBucket, isKnownBrand, type Bucket } from './taxonomy.js'

// ---------------------------------------------------------------------------
// Thresholds — keep in sync with prompts/system-prompt.md §1 and §5.3
// ---------------------------------------------------------------------------

export const DEMAND_SCORE_THRESHOLD = 60
export const CONFIDENCE_THRESHOLD = 0.7

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type FilterReason =
  | 'demand_score_too_low'
  | 'confidence_too_low'
  | 'both_too_low'

export interface KnownSignal {
  readonly signal: TrendSignal
  readonly bucket: Bucket
}

export interface UnknownSignal {
  readonly signal: TrendSignal
  readonly knownBrand: boolean // true if brand matched but brand_line did not
}

export interface ExcludedSignal {
  readonly signal: TrendSignal
  readonly bucket: 'F'
}

export interface FilteredOutSignal {
  readonly signal: TrendSignal
  readonly bucket: Bucket
  readonly reason: FilterReason
}

export type ValidateAndFilterResult =
  | {
      readonly status: 'parse_failed'
      readonly runId: string
      readonly error: z.ZodError
    }
  | {
      readonly status: 'ok'
      readonly runId: string
      readonly totalSignals: number
      readonly known: ReadonlyArray<KnownSignal>
      readonly unknown: ReadonlyArray<UnknownSignal>
      readonly excluded: ReadonlyArray<ExcludedSignal>
      readonly filteredOut: ReadonlyArray<FilteredOutSignal>
    }

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export function validateAndFilter(
  rawOutput: unknown,
  runId: string,
): ValidateAndFilterResult {
  const parsed = TrendAnalystOutputSchema.safeParse(rawOutput)
  if (!parsed.success) {
    return {
      status: 'parse_failed',
      runId,
      error: parsed.error,
    }
  }

  const known: KnownSignal[] = []
  const unknown: UnknownSignal[] = []
  const excluded: ExcludedSignal[] = []
  const filteredOut: FilteredOutSignal[] = []

  for (const signal of parsed.data.signals) {
    const bucket = resolveBucket(signal.brand, signal.brand_line)

    if (bucket === null) {
      // Unknown brand OR known brand with unmapped brand_line.
      // Both go to the discovery queue, with the knownBrand flag
      // distinguishing them for downstream review prioritization.
      unknown.push({
        signal,
        knownBrand: isKnownBrand(signal.brand),
      })
      continue
    }

    if (bucket === 'F') {
      // Bucket F = clone or excluded mass market. System prompt forbids
      // emitting these; if one leaks through we trap and log without
      // persisting.
      excluded.push({ signal, bucket: 'F' })
      continue
    }

    // Bucket A-E: known and allowed. Apply semantic thresholds.
    const demandFails = signal.demand_score < DEMAND_SCORE_THRESHOLD
    const confidenceFails = signal.confidence < CONFIDENCE_THRESHOLD

    if (demandFails || confidenceFails) {
      filteredOut.push({
        signal,
        bucket,
        reason:
          demandFails && confidenceFails
            ? 'both_too_low'
            : demandFails
              ? 'demand_score_too_low'
              : 'confidence_too_low',
      })
      continue
    }

    known.push({ signal, bucket })
  }

  return {
    status: 'ok',
    runId,
    totalSignals: parsed.data.signals.length,
    known,
    unknown,
    excluded,
    filteredOut,
  }
}
