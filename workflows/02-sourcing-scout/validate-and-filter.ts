/**
 * validate-and-filter — pure transformation from raw LLM output to a
 * structured decision about which providers to persist. The A2 (Sourcing
 * Scout) mirror of 01-trend-analyst/validate-and-filter.ts, adapted to the
 * provider contract.
 *
 * Pipeline:
 *   1. Parse the ENVELOPE (`{ providers: [...] }`). Failure here = the model
 *      returned structural garbage and the run is aborted (status
 *      'parse_failed'), exactly as A1 aborts on a bad output shape.
 *   2. For each candidate, run an ordered pipeline of composable rules
 *      (schema-parse → evidence-present → threshold → accept). The FIRST rule
 *      that fires decides the candidate's category. Unlike A1, a single
 *      malformed provider does NOT abort the run: it falls into `rejected` via
 *      the per-item safeParse, so one bad record can't take 29 good ones down.
 *   3. Partition into THREE destinations by rule outcome:
 *        - accepted    → cleared the gate, has evidence, and beat both
 *                        thresholds. The ONLY partition that reaches the UPSERT.
 *        - filteredOut → gate + evidence OK but below threshold. Calibration
 *                        gold: kept with raw scores + reason so the workflow can
 *                        log them; NOT garbage, just "valid but under today's
 *                        cut".
 *        - rejected    → failed a HARD rule (schema-invalid: missing/!url
 *                        catalog_url, score outside [0,1], malformed shape; or
 *                        evidence_empty). Malformation / fails-standard, distinct
 *                        from "below threshold".
 *   4. For accepted candidates ONLY, compute dedup_hash and drop intra-run
 *      duplicates (§7.8 is primarily the LLM's job; this is a cheap code safety
 *      net). dedup_hash is computed here — and only here — because deduplicating
 *      is part of the cut and needs identity. Hashing filteredOut/rejected would
 *      be wasted work, and a rejected record may have no valid identifier to
 *      hash on.
 *   5. Return the structured decision. The workflow Code node injects the
 *      remaining system-managed fields on accepted (trust_fulfillment: null,
 *      last_verified_at: null, id, run_id), runs the final ProviderSchema.parse
 *      as a whole-record assertion, and executes the UPSERT.
 *
 * NOTE — what this function deliberately does NOT do:
 *   - It does NOT inject trust_fulfillment / last_verified_at / id / run_id.
 *     Those are system fields this function does not filter on; stamping them
 *     here would mean opining on columns it does not own. The "complete record"
 *     assertion (ProviderSchema.parse) lives where the complete record is
 *     assembled — the Code node — not in two places.
 *   - It does NOT consume REFERENCE_BRANDS_V3. Those brands are a GRADED FIT
 *     SIGNAL the LLM already folded into trust_quality (see reference-brands.ts
 *     docblock + the SO schema trust_quality description). Re-scoring brands in
 *     code would duplicate the model's judgement and violate "the LLM judges,
 *     the code executes". A2's filter imports zero domain taxonomy — unlike A1,
 *     whose taxonomy.ts is an allow-list that structurally partitions.
 *
 * Side-effect-free and unit-testable without Postgres or n8n. The n8n Code node
 * wraps it.
 */

import { z } from 'zod'
import {
  ProviderRawSchema,
  SourcingScoutOutputSchema,
  type ProviderRaw,
} from './schemas/provider.schema.js'
import { computeDedupHash } from './scripts/dedup.js'

// ---------------------------------------------------------------------------
// Thresholds — single source of truth, exported so the calibration smoke
// (2R.4) can tune them in ONE place. These are STARTING HYPOTHESES to calibrate
// against the first real smoke run, NOT final numbers. Mirror of A1's
// DEMAND_SCORE_THRESHOLD / CONFIDENCE_THRESHOLD (on A1's 0-100 / 0-1 scales).
//
// Inclusive: a candidate fails only when it is STRICTLY below the threshold
// (score < THRESHOLD), so trust_quality == 0.6 and confidence == 0.7 PASS —
// matching A1's `< THRESHOLD` convention.
// ---------------------------------------------------------------------------

export const TRUST_QUALITY_THRESHOLD = 0.6 as const
export const CONFIDENCE_THRESHOLD = 0.7 as const

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Why a candidate failed a HARD rule (malformation / fails-standard). */
export type RejectReason = 'schema_invalid' | 'evidence_empty'

/** Why a well-formed candidate did not clear today's threshold. */
export type FilterReason =
  | 'trust_quality_too_low'
  | 'confidence_too_low'
  | 'both_too_low'

/**
 * An accepted provider: the raw LLM shape plus the dedup_hash this function
 * computed (it needed it to deduplicate). The two remaining system fields
 * (trust_fulfillment, last_verified_at) and id / run_id are injected by the
 * Code node before the UPSERT — deliberately absent here.
 */
export type AcceptedRecord = ProviderRaw & { readonly dedup_hash: string }

export interface AcceptedProvider {
  readonly provider: AcceptedRecord
}

export interface FilteredOutProvider {
  readonly provider: ProviderRaw
  readonly reason: FilterReason
}

export interface RejectedProvider {
  readonly raw: unknown
  readonly reason: RejectReason
  /** Present only when reason === 'schema_invalid'. */
  readonly error?: z.ZodError
}

export interface DuplicateProvider {
  readonly provider: AcceptedRecord
  readonly reason: 'duplicate_in_run'
}

export interface ValidateAndFilterStats {
  readonly totalCandidates: number
  readonly acceptedCount: number
  readonly filteredOutCount: number
  readonly rejectedCount: number
  readonly duplicatesDropped: number
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
      readonly stats: ValidateAndFilterStats
      readonly accepted: ReadonlyArray<AcceptedProvider>
      readonly filteredOut: ReadonlyArray<FilteredOutProvider>
      readonly rejected: ReadonlyArray<RejectedProvider>
      readonly duplicates: ReadonlyArray<DuplicateProvider>
    }

// ---------------------------------------------------------------------------
// Envelope — accept the wrapper loosely so per-item parsing can run. A bad
// envelope (not an object / missing providers / providers not an array) aborts
// the run; a bad ITEM does not (it is parsed individually below).
// ---------------------------------------------------------------------------

const EnvelopeSchema = z.object({ providers: z.array(z.unknown()) })

// ---------------------------------------------------------------------------
// Per-candidate classification — an ordered pipeline of composable rules. The
// first rule that fires decides the category; rules are flat guard clauses (no
// nested if-else), so a future fourth partition (e.g. needsReview) is inserted
// by adding a guard, not by rewriting the function.
// ---------------------------------------------------------------------------

type Classification =
  | { readonly kind: 'rejected'; readonly reason: RejectReason; readonly error?: z.ZodError }
  | { readonly kind: 'filteredOut'; readonly provider: ProviderRaw; readonly reason: FilterReason }
  | { readonly kind: 'accepted'; readonly provider: ProviderRaw }

/** Threshold rule, mirroring A1's both/one/other reason derivation. */
function thresholdReason(provider: ProviderRaw): FilterReason | null {
  const trustFails = provider.trust_quality < TRUST_QUALITY_THRESHOLD
  const confidenceFails = provider.confidence < CONFIDENCE_THRESHOLD
  if (trustFails && confidenceFails) return 'both_too_low'
  if (trustFails) return 'trust_quality_too_low'
  if (confidenceFails) return 'confidence_too_low'
  return null
}

function classify(raw: unknown): Classification {
  // Rule 1 — schema-parse. Catches the hard rules the Zod contract enforces:
  // missing/non-url catalog_url, score outside [0,1], any malformed shape.
  const parsed = ProviderRawSchema.safeParse(raw)
  if (!parsed.success) {
    return { kind: 'rejected', reason: 'schema_invalid', error: parsed.error }
  }
  const provider = parsed.data

  // Rule 2 — evidence must be non-empty. The schema allows [] ON PURPOSE
  // (2R.2: so the LLM emits the honest empty array instead of fabricating a URL
  // to clear a minItems). The cut for empty evidence lives HERE, as promised by
  // the SO schema docblock.
  if (provider.evidence_urls.length === 0) {
    return { kind: 'rejected', reason: 'evidence_empty' }
  }

  // Rule 3 — threshold. Below the cut but well-formed → filteredOut (kept for
  // calibration), not rejected.
  const reason = thresholdReason(provider)
  if (reason !== null) {
    return { kind: 'filteredOut', provider, reason }
  }

  // Rule 4 — accept.
  return { kind: 'accepted', provider }
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export function validateAndFilter(
  rawOutput: unknown,
  runId: string,
): ValidateAndFilterResult {
  const envelope = EnvelopeSchema.safeParse(rawOutput)
  if (!envelope.success) {
    return { status: 'parse_failed', runId, error: envelope.error }
  }

  const accepted: AcceptedProvider[] = []
  const filteredOut: FilteredOutProvider[] = []
  const rejected: RejectedProvider[] = []
  const duplicates: DuplicateProvider[] = []
  const seenHashes = new Set<string>()

  for (const raw of envelope.data.providers) {
    const classification = classify(raw)

    if (classification.kind === 'rejected') {
      rejected.push(
        classification.error !== undefined
          ? { raw, reason: classification.reason, error: classification.error }
          : { raw, reason: classification.reason },
      )
      continue
    }

    if (classification.kind === 'filteredOut') {
      filteredOut.push({
        provider: classification.provider,
        reason: classification.reason,
      })
      continue
    }

    // accepted — compute dedup_hash (catalog_url is a validated URL, so
    // computeDedupHash always has a fallback identifier and never throws here)
    // and drop intra-run duplicates by hash.
    const { provider } = classification
    const dedup_hash = computeDedupHash(
      provider.whatsapp,
      provider.instagram_handle,
      provider.catalog_url,
    )
    const record: AcceptedRecord = { ...provider, dedup_hash }

    if (seenHashes.has(dedup_hash)) {
      duplicates.push({ provider: record, reason: 'duplicate_in_run' })
      continue
    }
    seenHashes.add(dedup_hash)
    accepted.push({ provider: record })
  }

  return {
    status: 'ok',
    runId,
    stats: {
      totalCandidates: envelope.data.providers.length,
      acceptedCount: accepted.length,
      filteredOutCount: filteredOut.length,
      rejectedCount: rejected.length,
      duplicatesDropped: duplicates.length,
    },
    accepted,
    filteredOut,
    rejected,
    duplicates,
  }
}
