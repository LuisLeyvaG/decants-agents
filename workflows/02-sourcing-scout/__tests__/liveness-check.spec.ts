/**
 * Unit tests for the liveness check — ALL with an injected fake `requestImpl`.
 * Zero real network (mirrors brightdata-fetch.spec.ts's DI convention), so
 * `npm test` never opens a socket.
 *
 * Coverage (the 7 cases agreed for the MVP):
 *   1. 2xx           → alive
 *   2. non-2xx       → dead (reason='dead_site', detail='http_<code>')
 *   3. 3xx           → dead (we do NOT follow redirects as a sign of life)
 *   4. timeout       → dead (detail='timeout')
 *   5. DNS/NXDOMAIN  → dead (detail='dns')
 *   6. URL absent    → dead (detail='no_url') WITHOUT touching the network
 *   7. allSettled    → one dead site never tumbles the batch
 */

import { jest } from '@jest/globals'

import {
  checkLiveness,
  DEAD_SITE,
  type LivenessRequestImpl,
} from '../liveness-check.js'
import type { AcceptedProvider } from '../validate-and-filter.js'

// ---------------------------------------------------------------------------
// Fixtures — a full, contract-faithful AcceptedProvider so the tests exercise
// the real shape `validateAndFilter` emits (a ProviderRaw plus dedup_hash).
// ---------------------------------------------------------------------------

function acc(catalogUrl: string, name = 'Test Decants'): AcceptedProvider {
  return {
    provider: {
      source: 'web',
      source_id: null,
      name,
      catalog_url: catalogUrl,
      whatsapp: null,
      instagram_handle: null,
      evidence_urls: [`${catalogUrl}/about`],
      discovery_query: 'decants mexico',
      confidence: 0.9,
      trust_quality: 0.8,
      status: 'active',
      dedup_hash: `hash-${name}`,
    },
  }
}

/** A fake requestImpl replaying `steps` (a status number, or an Error to throw) in order. */
function fakeRequest(steps: Array<number | Error>): {
  impl: LivenessRequestImpl
  urls: string[]
} {
  const urls: string[] = []
  let i = 0
  const impl: LivenessRequestImpl = async (url) => {
    urls.push(url)
    const step = (steps[i] ?? steps[steps.length - 1]) as number | Error
    i += 1
    if (step instanceof Error) throw step
    return { statusCode: step }
  }
  return { impl, urls }
}

/** Build an Error carrying a machine `code` the way undici/Node surface them. */
function errWithCode(code: string, name?: string): Error {
  const e = new Error(`simulated ${code}`) as Error & { code: string }
  e.code = code
  if (name) e.name = name
  return e
}

// ---------------------------------------------------------------------------
// 1 — 2xx alive
// ---------------------------------------------------------------------------

describe('alive', () => {
  it('200 → alive, reason=null, httpStatus carried', async () => {
    const { impl, urls } = fakeRequest([200])
    const result = await checkLiveness([acc('https://shop.test')], { requestImpl: impl })

    expect(result.stats).toEqual({ total: 1, aliveCount: 1, deadCount: 0 })
    expect(result.alive).toHaveLength(1)
    expect(result.alive[0]).toMatchObject({
      status: 'alive',
      httpStatus: 200,
      reason: null,
      detail: null,
    })
    // the record is forwarded intact
    expect(result.alive[0]?.provider.provider.catalog_url).toBe('https://shop.test')
    expect(urls).toEqual(['https://shop.test'])
  })

  it('299 is still 2xx → alive; 200 boundary holds', async () => {
    const { impl } = fakeRequest([299])
    const result = await checkLiveness([acc('https://edge.test')], { requestImpl: impl })
    expect(result.stats.aliveCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 2 — non-2xx dead
// ---------------------------------------------------------------------------

describe('non-2xx → dead', () => {
  it('503 → dead, dead_site, detail=http_503, httpStatus=503', async () => {
    const { impl } = fakeRequest([503])
    const result = await checkLiveness([acc('https://down.test')], { requestImpl: impl })

    expect(result.stats).toEqual({ total: 1, aliveCount: 0, deadCount: 1 })
    expect(result.dead[0]).toMatchObject({
      status: 'dead',
      httpStatus: 503,
      reason: DEAD_SITE,
      detail: 'http_503',
    })
  })

  it('404 → dead, detail=http_404', async () => {
    const { impl } = fakeRequest([404])
    const result = await checkLiveness([acc('https://gone.test')], { requestImpl: impl })
    expect(result.dead[0]?.detail).toBe('http_404')
  })
})

// ---------------------------------------------------------------------------
// 3 — 3xx NOT treated as alive (explicit MVP decision)
// ---------------------------------------------------------------------------

describe('3xx → dead (redirects are not a sign of life)', () => {
  it('301 → dead, detail=http_301', async () => {
    const { impl } = fakeRequest([301])
    const result = await checkLiveness([acc('https://moved.test')], { requestImpl: impl })
    expect(result.stats.deadCount).toBe(1)
    expect(result.dead[0]).toMatchObject({ reason: DEAD_SITE, detail: 'http_301', httpStatus: 301 })
  })
})

// ---------------------------------------------------------------------------
// 4 — timeout dead
// ---------------------------------------------------------------------------

describe('timeout → dead', () => {
  it('TimeoutError → dead, detail=timeout, httpStatus=null', async () => {
    const { impl } = fakeRequest([errWithCode('UND_ERR_ABORTED', 'TimeoutError')])
    const result = await checkLiveness([acc('https://slow.test')], { requestImpl: impl })

    expect(result.dead[0]).toMatchObject({
      status: 'dead',
      httpStatus: null,
      reason: DEAD_SITE,
      detail: 'timeout',
    })
  })
})

// ---------------------------------------------------------------------------
// 5 — DNS / NXDOMAIN dead
// ---------------------------------------------------------------------------

describe('DNS failure → dead', () => {
  it('ENOTFOUND → dead, detail=dns', async () => {
    const { impl } = fakeRequest([errWithCode('ENOTFOUND')])
    const result = await checkLiveness([acc('https://nxdomain.test')], { requestImpl: impl })
    expect(result.dead[0]).toMatchObject({ reason: DEAD_SITE, detail: 'dns', httpStatus: null })
  })

  it('ECONNREFUSED → dead, detail=conn_refused', async () => {
    const { impl } = fakeRequest([errWithCode('ECONNREFUSED')])
    const result = await checkLiveness([acc('https://refused.test')], { requestImpl: impl })
    expect(result.dead[0]?.detail).toBe('conn_refused')
  })
})

// ---------------------------------------------------------------------------
// 6 — URL absent: dead WITHOUT touching the network
// ---------------------------------------------------------------------------

describe('absent URL → dead without a request', () => {
  it("empty catalog_url → dead, detail=no_url, requestImpl NEVER called", async () => {
    const spy = jest.fn<LivenessRequestImpl>(async () => ({ statusCode: 200 }))
    // Hand-crafted fixture: an empty catalog_url is UNREACHABLE under the current
    // contract (z.string().url(), already safeParsed). We force it to prove the
    // defensive guard short-circuits before any network call.
    const broken = acc('https://placeholder.test')
    const brokenWithNoUrl = {
      provider: { ...broken.provider, catalog_url: '' },
    } as unknown as AcceptedProvider

    const result = await checkLiveness([brokenWithNoUrl], { requestImpl: spy })

    expect(result.dead[0]).toMatchObject({
      status: 'dead',
      httpStatus: null,
      reason: DEAD_SITE,
      detail: 'no_url',
    })
    expect(spy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 7 — allSettled isolation: a mixed batch, one failure does not tumble the rest
// ---------------------------------------------------------------------------

describe('batch isolation', () => {
  it('alive + non-2xx + thrown error → each classified, run not aborted', async () => {
    // order: 1st alive(200), 2nd dead(500), 3rd throws (DNS)
    const { impl } = fakeRequest([200, 500, errWithCode('ENOTFOUND')])
    const result = await checkLiveness(
      [acc('https://a.test', 'A'), acc('https://b.test', 'B'), acc('https://c.test', 'C')],
      { requestImpl: impl },
    )

    expect(result.stats).toEqual({ total: 3, aliveCount: 1, deadCount: 2 })
    expect(result.alive.map((o) => o.provider.provider.name)).toEqual(['A'])
    const deadNames = result.dead.map((o) => o.provider.provider.name).sort()
    expect(deadNames).toEqual(['B', 'C'])
  })

  it('empty accepted → empty result, zero stats', async () => {
    const { impl } = fakeRequest([200])
    const result = await checkLiveness([], { requestImpl: impl })
    expect(result.stats).toEqual({ total: 0, aliveCount: 0, deadCount: 0 })
    expect(result.alive).toHaveLength(0)
    expect(result.dead).toHaveLength(0)
  })
})
