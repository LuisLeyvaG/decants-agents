/**
 * liveness-check — A2 (Sourcing Scout) post-filter availability gate. Runs
 * AFTER `validateAndFilter`, over the `accepted` partition it returns, and
 * before anything is persisted: a provider that cleared the scoring gate but
 * whose storefront no longer responds must not reach the UPSERT.
 *
 * Why this lives OUTSIDE validateAndFilter (and is async):
 *   validateAndFilter is a PURE, synchronous transformation (envelope parse →
 *   per-item classify → partition). The network has no place in it. Liveness is
 *   the impure, async sibling step: it takes the pure function's `accepted`
 *   output and probes the real world. Keeping them separate preserves the 220
 *   contract tests and keeps validateAndFilter unit-testable without a socket.
 *
 * Decision A — LOCAL trace, contract untouched:
 *   A dead site is tagged with the module-LOCAL literal `DEAD_SITE` ('dead_site'),
 *   NOT a value from the contract's `reason` enum (provider.schema.ts is not
 *   reopened this sprint). This preserves WHY each provider fell without widening
 *   the contract. When liveness is formalized, promote this literal into the enum
 *   (see TODO.md). The granular `detail` field records the concrete cause
 *   (timeout / dns / conn_refused / http_<code> / no_url) purely for the trace.
 *
 * MVP scope (deliberately narrow — see TODO.md for what is explicitly deferred):
 *   - GET (not HEAD): leaves the door open for future body inspection without a
 *     second round-trip; we just don't read the body yet.
 *   - Alive === HTTP 2xx, full stop. No body inspection, no "store disabled" /
 *     Cloudflare-1001 pattern detection, no treating 3xx as alive.
 *   - Direct egress IP. No Bright Data proxy this sprint (cost + speed).
 *   - 5000 ms timeout per site, in parallel via Promise.allSettled — a single
 *     failure (timeout / DNS / refused / non-2xx) marks ONE site dead and never
 *     aborts the run.
 *
 * Testability mirrors brightdata-fetch.ts: the network sits behind an injectable
 * `requestImpl`; the default impl is the ONLY code that imports real undici and
 * opens a socket. Tests pass a fake — zero real network in `npm test`.
 */

// Type-only import: `AcceptedProvider` is defined in validate-and-filter.ts (NOT
// in the contract schema), so importing its TYPE neither touches the contract nor
// adds a runtime dependency.
import type { AcceptedProvider } from './validate-and-filter.js'

// ---------------------------------------------------------------------------
// Local trace literal + tuning
// ---------------------------------------------------------------------------

/**
 * Module-LOCAL reason for a dead site. Deliberately NOT a member of the
 * contract's `reason` enum — see the docblock (Decision A) and TODO.md item (c).
 */
export const DEAD_SITE = 'dead_site' as const

/** Per-site request timeout. Fixed for this MVP. */
export const LIVENESS_TIMEOUT_MS = 5000 as const

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Granular cause of death, for the local trace only (never persisted as-is). */
export type DeadDetail =
  | 'timeout'
  | 'dns'
  | 'conn_refused'
  | `http_${number}`
  | 'no_url'
  | 'error'

export interface LivenessOutcome {
  /** The accepted record, forwarded INTACT (liveness never mutates it). */
  readonly provider: AcceptedProvider
  readonly status: 'alive' | 'dead'
  /** HTTP status when we got a response; null when none (timeout/DNS/refused/no_url). */
  readonly httpStatus: number | null
  /** Local trace literal: 'dead_site' on dead, null on alive. */
  readonly reason: typeof DEAD_SITE | null
  /** Granular cause for the trace; null on alive. */
  readonly detail: DeadDetail | null
}

export interface LivenessStats {
  readonly total: number
  readonly aliveCount: number
  readonly deadCount: number
}

export interface LivenessResult {
  readonly alive: ReadonlyArray<LivenessOutcome>
  readonly dead: ReadonlyArray<LivenessOutcome>
  readonly stats: LivenessStats
}

/**
 * Minimal request surface the liveness check needs: fire a GET, hand back the
 * status code. The default impl drains+discards the body; a fake in tests just
 * returns a status (or throws to simulate timeout/DNS/refused).
 */
export type LivenessRequestImpl = (
  url: string,
  opts: { readonly timeoutMs: number },
) => Promise<{ readonly statusCode: number }>

export interface LivenessDeps {
  /** Defaults to the real undici-backed GET. Override in tests. */
  readonly requestImpl?: LivenessRequestImpl
  /** Per-site timeout; defaults to LIVENESS_TIMEOUT_MS. */
  readonly timeoutMs?: number
}

// ---------------------------------------------------------------------------
// Error classification — map a thrown network error to a DeadDetail
// ---------------------------------------------------------------------------

/**
 * Classify a thrown request error into a granular trace detail. undici/Node put
 * the machine cause on `error.code` (ENOTFOUND/EAI_AGAIN for DNS, ECONNREFUSED
 * for a refused connection); a timeout aborts the signal, surfacing as a
 * TimeoutError / AbortError. Everything unrecognised collapses to 'error'.
 */
function classifyError(err: unknown): DeadDetail {
  const code = (err as { code?: unknown })?.code
  const name = (err as { name?: unknown })?.name
  if (name === 'TimeoutError' || name === 'AbortError' || code === 'UND_ERR_ABORTED') {
    return 'timeout'
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns'
  if (code === 'ECONNREFUSED') return 'conn_refused'
  return 'error'
}

// ---------------------------------------------------------------------------
// Default (real) request implementation — the only network-touching code
// ---------------------------------------------------------------------------

/**
 * Real GET over the direct egress IP (no proxy this sprint). We issue a GET so a
 * future body-inspection step needs no second round-trip, but we do NOT read the
 * body now — so we MUST `res.body.dump()` to drain and free the socket, otherwise
 * the connection leaks and the process can hang. Timeout via AbortSignal.timeout
 * (the repo convention — see smoke-sourcing.ts / brightdata-fetch.ts), which is
 * an AbortController under the hood.
 */
const defaultRequestImpl: LivenessRequestImpl = async (url, { timeoutMs }) => {
  const { request } = await import('undici')
  const res = await request(url, {
    method: 'GET',
    signal: AbortSignal.timeout(timeoutMs),
  })
  await res.body.dump() // GET-without-read: discard the body so the socket frees
  return { statusCode: res.statusCode }
}

// ---------------------------------------------------------------------------
// Per-provider probe
// ---------------------------------------------------------------------------

function alive(provider: AcceptedProvider, httpStatus: number): LivenessOutcome {
  return { provider, status: 'alive', httpStatus, reason: null, detail: null }
}

function dead(
  provider: AcceptedProvider,
  httpStatus: number | null,
  detail: DeadDetail,
): LivenessOutcome {
  return { provider, status: 'dead', httpStatus, reason: DEAD_SITE, detail }
}

/**
 * Probe ONE accepted provider. Never throws: every failure mode resolves to a
 * `dead` outcome so one bad site can't tumble the batch (Promise.allSettled in
 * the caller is the second belt).
 */
async function probe(
  accepted: AcceptedProvider,
  requestImpl: LivenessRequestImpl,
  timeoutMs: number,
): Promise<LivenessOutcome> {
  const url = accepted.provider.catalog_url

  // Defensive guard. Under the CURRENT contract this branch is UNREACHABLE for a
  // legitimate `accepted`: provider.schema.ts types catalog_url as a required,
  // non-null `z.string().url()`, and every accepted record already passed
  // ProviderRawSchema.safeParse. We keep the guard anyway — a site we cannot even
  // address is unverifiable, and the liveness gate's job is to NOT pass through
  // the unverifiable. It is exercised in tests via a hand-crafted fixture.
  if (typeof url !== 'string' || url.trim() === '') {
    return dead(accepted, null, 'no_url')
  }

  try {
    const { statusCode } = await requestImpl(url, { timeoutMs })
    // Alive === 2xx, strictly. 3xx/4xx/5xx are dead: we do NOT follow redirects
    // as a sign of life, and a disabled-store page often answers 200-with-a-body
    // (deferred to TODO.md, item a) — but a non-2xx is unambiguously not alive.
    if (statusCode >= 200 && statusCode < 300) {
      return alive(accepted, statusCode)
    }
    return dead(accepted, statusCode, `http_${statusCode}`)
  } catch (err) {
    return dead(accepted, null, classifyError(err))
  }
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Probe every accepted provider's storefront in parallel and partition into
 * alive/dead. Pure-ish at the seams: the only impurity is `requestImpl`, which is
 * injectable. Returns a result with its own LOCAL shape — it does not reuse the
 * contract's `reason` enum (Decision A).
 */
export async function checkLiveness(
  accepted: ReadonlyArray<AcceptedProvider>,
  deps: LivenessDeps = {},
): Promise<LivenessResult> {
  const requestImpl = deps.requestImpl ?? defaultRequestImpl
  const timeoutMs = deps.timeoutMs ?? LIVENESS_TIMEOUT_MS

  // allSettled is the second belt: probe() already never rejects, but allSettled
  // guarantees that even an unexpected throw marks one site dead instead of
  // aborting the whole run.
  const settled = await Promise.allSettled(
    accepted.map((a) => probe(a, requestImpl, timeoutMs)),
  )

  const alive: LivenessOutcome[] = []
  const deadOut: LivenessOutcome[] = []
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i] as PromiseSettledResult<LivenessOutcome>
    const outcome =
      s.status === 'fulfilled'
        ? s.value
        : dead(accepted[i] as AcceptedProvider, null, 'error')
    if (outcome.status === 'alive') alive.push(outcome)
    else deadOut.push(outcome)
  }

  return {
    alive,
    dead: deadOut,
    stats: {
      total: accepted.length,
      aliveCount: alive.length,
      deadCount: deadOut.length,
    },
  }
}

// ---------------------------------------------------------------------------
// INTEGRATION POINT — described, NOT wired this sprint (P2).
// ---------------------------------------------------------------------------
//
// In the n8n Code node that wraps validateAndFilter (see validate-and-filter.ts
// docblock, step 5), AFTER computing `result` and only when `result.status ===
// 'ok'`:
//
//     const liveness = await checkLiveness(result.accepted)
//     // ONLY liveness.alive proceeds: inject trust_fulfillment/last_verified_at/
//     // id/run_id on each alive.provider, run ProviderSchema.parse, then UPSERT.
//     // liveness.dead is logged with its `reason` ('dead_site') + `detail` for the
//     // run trace; those providers are NOT persisted.
//
// Deliberately left UNWIRED here — activating it in the production workflow is a
// separate sprint (P2). This module ships as function + tests + this description.
