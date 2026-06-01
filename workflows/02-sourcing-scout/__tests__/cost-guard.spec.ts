/**
 * Unit tests for the CostGuard accountant + circuit breaker.
 *
 * The contract: bytes convert to USD at exactly $costPerGbUsd; the budget and
 * failure ceilings are INCLUSIVE (hitting them exactly trips); a success resets
 * the consecutive-failure streak; the snapshot mirrors the live state. All pure
 * — no network, no mocks needed beyond the guard itself.
 */

import {
  CostGuard,
  CostGuardTrippedError,
  type TripReason,
} from '../scripts/cost-guard.js'

const V1 = { maxSpendUsd: 2.0, costPerGbUsd: 8.0, maxConsecutiveFailures: 3 } as const

describe('CostGuard constructor invariants', () => {
  it.each([
    [{ maxSpendUsd: 0, costPerGbUsd: 8, maxConsecutiveFailures: 3 }, /maxSpendUsd/],
    [{ maxSpendUsd: 2, costPerGbUsd: 0, maxConsecutiveFailures: 3 }, /costPerGbUsd/],
    [{ maxSpendUsd: 2, costPerGbUsd: 8, maxConsecutiveFailures: 0 }, /maxConsecutiveFailures/],
    [{ maxSpendUsd: 2, costPerGbUsd: 8, maxConsecutiveFailures: 1.5 }, /maxConsecutiveFailures/],
  ])('throws on bad options %o', (opts, re) => {
    expect(() => new CostGuard(opts)).toThrow(re)
  })
})

describe('recordBytes → USD conversion', () => {
  it('converts 0.25 GB to exactly $2.00 at $8/GB', () => {
    const guard = new CostGuard(V1)
    guard.recordBytes(0.25 * 1e9) // 250,000,000 bytes
    expect(guard.snapshot().spentUsd).toBeCloseTo(2.0, 10)
    expect(guard.snapshot().bytesTransferred).toBe(0.25 * 1e9)
  })

  it('accumulates across multiple calls', () => {
    const guard = new CostGuard(V1)
    guard.recordBytes(1e8) // 0.1 GB → $0.80
    guard.recordBytes(1e8) // +0.1 GB → $1.60
    expect(guard.snapshot().spentUsd).toBeCloseTo(1.6, 10)
    expect(guard.snapshot().bytesTransferred).toBe(2e8)
  })

  it.each([[-1], [NaN], [Infinity]])('rejects non-finite/negative bytes %p', (bad) => {
    const guard = new CostGuard(V1)
    expect(() => guard.recordBytes(bad)).toThrow(/finite, non-negative/)
  })
})

describe('assertCanProceed — budget ceiling (inclusive)', () => {
  it('does NOT trip just below the budget', () => {
    const guard = new CostGuard(V1)
    guard.recordBytes(0.249 * 1e9) // $1.992
    expect(() => guard.assertCanProceed()).not.toThrow()
  })

  it('trips at the EXACT edge (spentUsd == maxSpendUsd)', () => {
    const guard = new CostGuard(V1)
    guard.recordBytes(0.25 * 1e9) // exactly $2.00 == maxSpendUsd
    let caught: unknown
    try {
      guard.assertCanProceed()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(CostGuardTrippedError)
    expect((caught as CostGuardTrippedError).reason).toBe<TripReason>('budget')
  })
})

describe('assertCanProceed — consecutive-failure breaker', () => {
  it('trips on the 3rd consecutive failure with reason "failures"', () => {
    const guard = new CostGuard(V1)
    guard.recordFailure()
    guard.recordFailure()
    expect(() => guard.assertCanProceed()).not.toThrow() // 2 < 3
    guard.recordFailure()
    expect(() => guard.assertCanProceed()).toThrow(CostGuardTrippedError)
    try {
      guard.assertCanProceed()
    } catch (e) {
      expect((e as CostGuardTrippedError).reason).toBe<TripReason>('failures')
    }
  })

  it('a success between failures RESETS the streak', () => {
    const guard = new CostGuard(V1)
    guard.recordFailure()
    guard.recordFailure()
    guard.recordSuccess() // reset to 0
    guard.recordFailure()
    guard.recordFailure()
    expect(guard.snapshot().consecutiveFailures).toBe(2)
    expect(() => guard.assertCanProceed()).not.toThrow()
  })
})

describe('budget takes precedence over failures when both hold', () => {
  it('reports "budget" if over budget AND over failures', () => {
    const guard = new CostGuard(V1)
    guard.recordBytes(0.25 * 1e9) // over budget
    guard.recordFailure()
    guard.recordFailure()
    guard.recordFailure() // also over failures
    try {
      guard.assertCanProceed()
    } catch (e) {
      expect((e as CostGuardTrippedError).reason).toBe<TripReason>('budget')
    }
  })
})

describe('snapshot reflects live state', () => {
  it('tracks fetchCount, failures, tripped and tripReason', () => {
    const guard = new CostGuard(V1)
    expect(guard.snapshot()).toMatchObject({
      spentUsd: 0,
      bytesTransferred: 0,
      fetchCount: 0,
      consecutiveFailures: 0,
      tripped: false,
      tripReason: null,
    })
    guard.recordBytes(1e7)
    guard.recordSuccess()
    guard.recordFailure()
    const snap = guard.snapshot()
    expect(snap.fetchCount).toBe(2)
    expect(snap.consecutiveFailures).toBe(1)
    expect(snap.tripped).toBe(false)
  })
})

describe('parametrized sub-limit (smoke runs at $0.50)', () => {
  it.each([
    [2.0, 0.25 * 1e9], // v1 budget trips at 0.25 GB
    [0.5, 0.0625 * 1e9], // smoke sub-limit trips at 0.0625 GB
  ])('budget $%p trips at exactly its edge (%p bytes)', (maxSpendUsd, edgeBytes) => {
    const guard = new CostGuard({ maxSpendUsd, costPerGbUsd: 8.0, maxConsecutiveFailures: 3 })
    guard.recordBytes(edgeBytes - 1) // one byte under → fine
    expect(() => guard.assertCanProceed()).not.toThrow()
    guard.recordBytes(1) // reach the edge exactly
    expect(() => guard.assertCanProceed()).toThrow(/budget/)
  })
})
