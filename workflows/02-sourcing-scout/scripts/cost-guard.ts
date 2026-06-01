/**
 * Cost accounting + circuit breaker for Agente 2 (Sourcing Scout) — Sprint 2.
 *
 * This is the FIRST sprint that spends real money (Bright Data residential
 * proxies, billed at $/GB on real bytes transferred). The `CostGuard` is the
 * safety valve: it keeps a running tally of bytes/USD and consecutive failures
 * and decides, BEFORE every fetch, whether the run may proceed.
 *
 * Deliberately PURE: zero network, zero DB, zero I/O. It only counts and
 * decides. The network wrapper (`brightdata-fetch.ts`) injects an instance and
 * calls `assertCanProceed()` / `recordBytes()` / `recordSuccess()` /
 * `recordFailure()`; the guard never reaches out on its own. This is what makes
 * the money-critical logic 100% unit-testable without a single real request.
 *
 * Invariants are validated in the constructor (mirroring `scoring.ts`'s
 * `assertWeightsSumToOne`): a misconfigured guard fails fast at construction
 * rather than silently letting a run spend unbounded money.
 */

/** Reason a guard tripped, so the caller can branch (abort run vs degrade tier). */
export type TripReason = 'budget' | 'failures'

/**
 * Thrown by `assertCanProceed()` when the guard has tripped. Carries `reason`
 * so the caller decides what to do: `'budget'` → abort the run entirely;
 * `'failures'` → the upstream may choose to abort or degrade providers to tier
 * 3. The network wrapper MUST NOT swallow this — it propagates so the run aborts.
 */
export class CostGuardTrippedError extends Error {
  readonly reason: TripReason

  constructor(reason: TripReason, message: string) {
    super(message)
    this.name = 'CostGuardTrippedError'
    this.reason = reason
  }
}

export interface CostGuardOptions {
  /** Hard ceiling on spend for this run, in USD. v1: 2.0 (smoke sub-limit: 0.50). */
  readonly maxSpendUsd: number
  /** Bright Data residential pricing. v1: 8.0 ($8/GB). */
  readonly costPerGbUsd: number
  /** Consecutive-failure threshold that trips the breaker. v1: 3. */
  readonly maxConsecutiveFailures: number
}

/** Immutable view of the guard's state, for logging into `run_logs.metadata`. */
export interface CostGuardSnapshot {
  readonly spentUsd: number
  readonly bytesTransferred: number
  readonly fetchCount: number
  readonly consecutiveFailures: number
  readonly tripped: boolean
  readonly tripReason: TripReason | null
}

/** Bytes per gigabyte (decimal GB, matching how proxies bill: 1 GB = 1e9 bytes). */
const BYTES_PER_GB = 1e9

/**
 * Running cost accountant + consecutive-failure circuit breaker.
 *
 * Usage from the network wrapper, once per fetch attempt:
 *   guard.assertCanProceed()      // throws CostGuardTrippedError if tripped
 *   // ... perform the attempt ...
 *   guard.recordBytes(onWireBytes)
 *   attemptOk ? guard.recordSuccess() : guard.recordFailure()
 */
export class CostGuard {
  private readonly maxSpendUsd: number
  private readonly costPerGbUsd: number
  private readonly maxConsecutiveFailures: number

  private spentUsd = 0
  private bytesTransferred = 0
  private fetchCount = 0
  private consecutiveFailures = 0

  constructor(opts: CostGuardOptions) {
    if (!(opts.maxSpendUsd > 0)) {
      throw new Error(`CostGuard: maxSpendUsd must be > 0, got ${opts.maxSpendUsd}`)
    }
    if (!(opts.costPerGbUsd > 0)) {
      throw new Error(`CostGuard: costPerGbUsd must be > 0, got ${opts.costPerGbUsd}`)
    }
    if (!Number.isInteger(opts.maxConsecutiveFailures) || opts.maxConsecutiveFailures < 1) {
      throw new Error(
        `CostGuard: maxConsecutiveFailures must be an integer >= 1, got ${opts.maxConsecutiveFailures}`,
      )
    }
    this.maxSpendUsd = opts.maxSpendUsd
    this.costPerGbUsd = opts.costPerGbUsd
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures
  }

  /**
   * Accumulate bytes transferred (on-wire, request + response) and convert to
   * USD at `costPerGbUsd`. Negative or non-finite inputs throw (a bug in the
   * caller's byte accounting must surface, not silently corrupt the tally).
   */
  recordBytes(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new Error(`CostGuard.recordBytes: bytes must be a finite, non-negative number, got ${bytes}`)
    }
    this.bytesTransferred += bytes
    this.spentUsd += (bytes / BYTES_PER_GB) * this.costPerGbUsd
  }

  /** Count one completed fetch (regardless of outcome) and reset the failure streak. */
  recordSuccess(): void {
    this.fetchCount += 1
    this.consecutiveFailures = 0
  }

  /** Count one completed fetch (regardless of outcome) and extend the failure streak. */
  recordFailure(): void {
    this.fetchCount += 1
    this.consecutiveFailures += 1
  }

  /** Whether the guard has tripped, and on which reason (budget wins if both hold). */
  private trip(): TripReason | null {
    if (this.spentUsd >= this.maxSpendUsd) return 'budget'
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) return 'failures'
    return null
  }

  /**
   * Throw `CostGuardTrippedError` if the budget is exhausted (`spentUsd >=
   * maxSpendUsd`) OR the consecutive-failure threshold is reached
   * (`consecutiveFailures >= maxConsecutiveFailures`). The bounds are INCLUSIVE:
   * hitting the ceiling exactly trips. Call this BEFORE every fetch attempt.
   */
  assertCanProceed(): void {
    const reason = this.trip()
    if (reason === 'budget') {
      throw new CostGuardTrippedError(
        'budget',
        `CostGuard tripped: spent $${this.spentUsd.toFixed(4)} >= budget $${this.maxSpendUsd.toFixed(2)}.`,
      )
    }
    if (reason === 'failures') {
      throw new CostGuardTrippedError(
        'failures',
        `CostGuard tripped: ${this.consecutiveFailures} consecutive failures >= limit ${this.maxConsecutiveFailures}.`,
      )
    }
  }

  /** Snapshot the current state for logging into `run_logs.metadata`. */
  snapshot(): CostGuardSnapshot {
    const tripReason = this.trip()
    return {
      spentUsd: this.spentUsd,
      bytesTransferred: this.bytesTransferred,
      fetchCount: this.fetchCount,
      consecutiveFailures: this.consecutiveFailures,
      tripped: tripReason !== null,
      tripReason,
    }
  }
}
