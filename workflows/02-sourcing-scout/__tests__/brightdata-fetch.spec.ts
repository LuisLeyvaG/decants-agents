/**
 * Unit tests for the Bright Data fetch wrapper — ALL with an injected fake
 * `requestImpl`. Zero real network, zero real timers (sleep is a no-op).
 *
 * Coverage mirrors the Sprint 2 spec: retry classification, sticky session in
 * the proxy username, guard orchestration, env validation at construction,
 * ON-WIRE (compressed) byte accounting, graceful decompression, and the
 * security guarantee that the proxy password never leaks through an error.
 */

import { gzipSync } from 'node:zlib'

import { jest } from '@jest/globals'

import { CostGuard, CostGuardTrippedError } from '../scripts/cost-guard.js'
import {
  createBrightDataFetcher,
  HEADER_OVERHEAD_BYTES,
  redactSecrets,
  type RawResponse,
  type RequestImpl,
  type RequestImplOptions,
} from '../scripts/brightdata-fetch.js'

const FAKE_CA = '-----BEGIN CERTIFICATE-----\nFAKEBRIGHTDATACA\n-----END CERTIFICATE-----\n'

const ENV = {
  BRIGHTDATA_ENDPOINT: 'brd.superproxy.io:33335',
  BRIGHTDATA_USERNAME: 'brd-customer-hl_ee9d698f-zone-leyvascents_mx',
  BRIGHTDATA_PASSWORD: 's3cr3t-p@ss', // special char to exercise URL-encoding + redaction
  BRIGHTDATA_CA_CERT: '/fake/path/brightdata-ca.crt',
} as const

const NOOP_SLEEP = async (): Promise<void> => {}

/** Default injected CA reader for tests — returns FAKE_CA without touching the filesystem. */
const fakeReadCa = (): string => FAKE_CA

function newGuard(overrides: Partial<{ maxSpendUsd: number; maxConsecutiveFailures: number }> = {}): CostGuard {
  return new CostGuard({
    maxSpendUsd: overrides.maxSpendUsd ?? 2.0,
    costPerGbUsd: 8.0,
    maxConsecutiveFailures: overrides.maxConsecutiveFailures ?? 3,
  })
}

function bodyOf(buf: Buffer): AsyncIterable<Buffer> {
  return {
    async *[Symbol.asyncIterator]() {
      yield buf
    },
  }
}

/** Build a RawResponse. If `gzip`, the wire body is the gzip of `text` and content-encoding is set. */
function resp(
  status: number,
  text = 'ok',
  opts: { gzip?: boolean; headers?: Record<string, string> } = {},
): RawResponse {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  let wire: Buffer
  if (opts.gzip) {
    wire = gzipSync(Buffer.from(text, 'utf8'))
    headers['content-encoding'] = 'gzip'
  } else {
    wire = Buffer.from(text, 'utf8')
  }
  return { statusCode: status, headers, body: bodyOf(wire) }
}

/** A fake requestImpl that replays `steps` (RawResponse or Error) in order and records the options it saw. */
function fakeRequest(steps: Array<RawResponse | Error>): {
  impl: RequestImpl
  calls: RequestImplOptions[]
} {
  const calls: RequestImplOptions[] = []
  let i = 0
  const impl: RequestImpl = async (_url, options) => {
    calls.push(options)
    const step = steps[i] ?? steps[steps.length - 1]
    i += 1
    if (step instanceof Error) throw step
    return step as RawResponse
  }
  return { impl, calls }
}

function fetcher(steps: Array<RawResponse | Error>, env: Record<string, string> = ENV) {
  const { impl, calls } = fakeRequest(steps)
  const fn = createBrightDataFetcher({ env, requestImpl: impl, sleep: NOOP_SLEEP, readCaFile: fakeReadCa })
  return { fn, calls }
}

describe('retry classification', () => {
  it('200 on the first try → 1 attempt, recordSuccess, recordBytes called', async () => {
    const guard = newGuard()
    const success = jest.spyOn(guard, 'recordSuccess')
    const failure = jest.spyOn(guard, 'recordFailure')
    const bytes = jest.spyOn(guard, 'recordBytes')
    const { fn, calls } = fetcher([resp(200, '<html>ok</html>')])

    const result = await fn({ url: 'https://example.test/', guard })

    expect(result.status).toBe(200)
    expect(result.attempts).toBe(1)
    expect(calls).toHaveLength(1)
    expect(success).toHaveBeenCalledTimes(1)
    expect(failure).not.toHaveBeenCalled()
    expect(bytes).toHaveBeenCalledTimes(1)
  })

  it('503, 503, then 200 → 3 attempts, recordFailure×2 + recordSuccess', async () => {
    const guard = newGuard()
    const success = jest.spyOn(guard, 'recordSuccess')
    const failure = jest.spyOn(guard, 'recordFailure')
    const { fn } = fetcher([resp(503), resp(503), resp(200)])

    const result = await fn({ url: 'https://example.test/', guard })

    expect(result.status).toBe(200)
    expect(result.attempts).toBe(3)
    expect(failure).toHaveBeenCalledTimes(2)
    expect(success).toHaveBeenCalledTimes(1)
  })

  it('404 → 1 attempt, NO retry, recordFailure', async () => {
    const guard = newGuard()
    const success = jest.spyOn(guard, 'recordSuccess')
    const failure = jest.spyOn(guard, 'recordFailure')
    const { fn, calls } = fetcher([resp(404, 'not found')])

    const result = await fn({ url: 'https://example.test/', guard })

    expect(result.status).toBe(404)
    expect(result.attempts).toBe(1)
    expect(calls).toHaveLength(1)
    expect(failure).toHaveBeenCalledTimes(1)
    expect(success).not.toHaveBeenCalled()
  })

  it('429 → DOES retry', async () => {
    const guard = newGuard()
    const success = jest.spyOn(guard, 'recordSuccess')
    const failure = jest.spyOn(guard, 'recordFailure')
    const { fn, calls } = fetcher([resp(429), resp(200)])

    const result = await fn({ url: 'https://example.test/', guard })

    expect(result.status).toBe(200)
    expect(result.attempts).toBe(2)
    expect(calls).toHaveLength(2)
    expect(failure).toHaveBeenCalledTimes(1)
    expect(success).toHaveBeenCalledTimes(1)
  })
})

describe('sticky session in the proxy username', () => {
  it('sticky=true → username/url passed to the proxy include -session-<id>', async () => {
    const guard = newGuard()
    const { fn, calls } = fetcher([resp(200)])

    const result = await fn({ url: 'https://example.test/', guard, sticky: true, sessionId: 'abc123' })

    expect(calls[0]?.proxyUsername).toBe(`${ENV.BRIGHTDATA_USERNAME}-session-abc123`)
    expect(calls[0]?.proxyUrl).toContain('-session-abc123')
    expect(result.sessionId).toBe('abc123')
  })

  it('rotating (no sticky) → no -session- and sessionId is null', async () => {
    const guard = newGuard()
    const { fn, calls } = fetcher([resp(200)])

    const result = await fn({ url: 'https://example.test/', guard })

    expect(calls[0]?.proxyUsername).toBe(ENV.BRIGHTDATA_USERNAME)
    expect(calls[0]?.proxyUrl).not.toContain('-session-')
    expect(result.sessionId).toBeNull()
  })

  it('sticky=true without sessionId → one is generated', async () => {
    const guard = newGuard()
    const { fn, calls } = fetcher([resp(200)])

    const result = await fn({
      url: 'https://example.test/',
      guard,
      sticky: true,
      // generator is the real crypto one; we only assert it produced something
    })

    expect(result.sessionId).toMatch(/^[0-9a-f]{12}$/)
    expect(calls[0]?.proxyUsername).toContain(`-session-${result.sessionId}`)
  })
})

describe('guard orchestration', () => {
  it('guard already tripped → assertCanProceed throws and the fetch is never attempted', async () => {
    const guard = newGuard({ maxSpendUsd: 0.5 })
    guard.recordBytes(0.5 * 1e9) // spend exactly the budget → tripped
    const { fn, calls } = fetcher([resp(200)])

    await expect(fn({ url: 'https://example.test/', guard })).rejects.toBeInstanceOf(CostGuardTrippedError)
    expect(calls).toHaveLength(0)
  })

  it('a CostGuardTrippedError is never swallowed as a network error', async () => {
    const guard = newGuard({ maxSpendUsd: 0.5 })
    guard.recordBytes(0.5 * 1e9)
    const { fn } = fetcher([new Error('network boom')])

    await expect(fn({ url: 'https://example.test/', guard })).rejects.toBeInstanceOf(CostGuardTrippedError)
  })
})

describe('env validation at construction', () => {
  it.each(['BRIGHTDATA_ENDPOINT', 'BRIGHTDATA_USERNAME', 'BRIGHTDATA_PASSWORD', 'BRIGHTDATA_CA_CERT'])(
    'throws at construction when %s is missing',
    (missing) => {
      const env: Record<string, string> = { ...ENV }
      delete env[missing]
      expect(() =>
        createBrightDataFetcher({ env, requestImpl: fakeRequest([]).impl, readCaFile: fakeReadCa }),
      ).toThrow(new RegExp(missing))
    },
  )

  it('throws when a required var is blank', () => {
    expect(() =>
      createBrightDataFetcher({
        env: { ...ENV, BRIGHTDATA_PASSWORD: '   ' },
        requestImpl: fakeRequest([]).impl,
        readCaFile: fakeReadCa,
      }),
    ).toThrow(/BRIGHTDATA_PASSWORD/)
  })
})

describe('Bright Data CA is required and scoped to the proxy (never global, never insecure)', () => {
  it('passes the CA cert content through to the request layer (→ ProxyAgent requestTls.ca)', async () => {
    const guard = newGuard()
    // Use the real factory path with an injected reader, and a mock requestImpl
    // that captures the options the wrapper hands to the (would-be) ProxyAgent.
    const { impl, calls } = fakeRequest([resp(200)])
    const fn = createBrightDataFetcher({
      env: ENV,
      requestImpl: impl,
      sleep: NOOP_SLEEP,
      readCaFile: () => FAKE_CA,
    })

    await fn({ url: 'https://example.test/', guard })

    // This is exactly what defaultRequestImpl forwards into `new ProxyAgent({ requestTls: { ca } })`.
    expect(calls[0]?.caCert).toBe(FAKE_CA)
  })

  it('throws a clear error at construction when BRIGHTDATA_CA_CERT is missing — NOT insecure', () => {
    const env: Record<string, string> = { ...ENV }
    delete env.BRIGHTDATA_CA_CERT
    expect(() =>
      createBrightDataFetcher({ env, requestImpl: fakeRequest([]).impl, readCaFile: fakeReadCa }),
    ).toThrow(/BRIGHTDATA_CA_CERT/)
  })

  it('throws a clear error when the CA file cannot be read', () => {
    const readThatThrows = (path: string): string => {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`)
    }
    expect(() =>
      createBrightDataFetcher({ env: ENV, requestImpl: fakeRequest([]).impl, readCaFile: readThatThrows }),
    ).toThrow(/could not read Bright Data CA cert/)
  })

  it('throws when the CA file is empty', () => {
    expect(() =>
      createBrightDataFetcher({ env: ENV, requestImpl: fakeRequest([]).impl, readCaFile: () => '   ' }),
    ).toThrow(/empty/)
  })
})

describe('on-wire (compressed) byte accounting', () => {
  it('a gzipped body counts the COMPRESSED wire bytes, not the decompressed length', async () => {
    const guard = newGuard()
    const bytes = jest.spyOn(guard, 'recordBytes')

    const payload = 'A'.repeat(300_000) // ~300 KB decompressed, compresses to a few hundred bytes
    const wireLen = gzipSync(Buffer.from(payload, 'utf8')).length
    expect(wireLen).toBeLessThan(payload.length / 10) // sanity: real compression happened

    const { fn } = fetcher([resp(200, payload, { gzip: true })])
    const result = await fn({ url: 'https://example.test/', guard })

    const expected = HEADER_OVERHEAD_BYTES + wireLen
    expect(bytes).toHaveBeenCalledWith(expected)
    expect(result.bytesTransferred).toBe(expected)
    // Decisively NOT the decompressed size:
    expect(result.bytesTransferred).toBeLessThan(payload.length)
    // ...and the returned body IS decompressed correctly:
    expect(result.body).toBe(payload)
  })

  it('an identity (no content-encoding) body is used as-is and counted as its plain bytes', async () => {
    const guard = newGuard()
    const bytes = jest.spyOn(guard, 'recordBytes')
    const payload = '<html>plain</html>'

    const { fn } = fetcher([resp(200, payload)])
    const result = await fn({ url: 'https://example.test/', guard })

    expect(result.body).toBe(payload)
    expect(bytes).toHaveBeenCalledWith(HEADER_OVERHEAD_BYTES + Buffer.byteLength(payload))
  })

  it('an unknown content-encoding degrades to raw bytes without crashing (+ warns)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const guard = newGuard()
    const payload = '<html>not really compressed</html>'

    // Body is plain bytes but the header lies about the encoding.
    const { fn } = fetcher([resp(200, payload, { headers: { 'content-encoding': 'weird-codec' } })])
    const result = await fn({ url: 'https://example.test/', guard })

    expect(result.body).toBe(payload)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('weird-codec'))
    warn.mockRestore()
  })
})

describe('security: the proxy password never leaks', () => {
  it('an error carrying the proxy URL is propagated with the password redacted', async () => {
    const guard = newGuard()
    // The fake throws an error whose message contains the full proxy URL (with the encoded password).
    const thrower: RequestImpl = async (_url, options) => {
      throw new Error(`CONNECT failed for ${options.proxyUrl}`)
    }
    const fn = createBrightDataFetcher({ env: ENV, requestImpl: thrower, sleep: NOOP_SLEEP, readCaFile: fakeReadCa })

    let caught: Error | undefined
    try {
      await fn({ url: 'https://example.test/', guard, maxRetries: 0 })
    } catch (e) {
      caught = e as Error
    }

    expect(caught).toBeDefined()
    const msg = caught!.message
    expect(msg).not.toContain('s3cr3t-p@ss') // raw password
    expect(msg).not.toContain(encodeURIComponent('s3cr3t-p@ss')) // URL-encoded password
    expect(msg).toContain('***')
  })

  it('redactSecrets scrubs raw and URL-encoded password forms', () => {
    const out = redactSecrets('user:s3cr3t-p@ss and enc s3cr3t-p%40ss', 's3cr3t-p@ss')
    expect(out).not.toContain('s3cr3t-p@ss')
    expect(out).not.toContain('s3cr3t-p%40ss')
    expect(out).toContain('***')
  })
})

describe('redirect Location header (exposed for navigation; still NOT auto-followed)', () => {
  it('302 with Location → result.location is that URL, and it is NOT followed', async () => {
    const guard = newGuard()
    const target = 'https://example.test/search-results?q=dior'
    const { fn, calls } = fetcher([resp(302, '', { headers: { location: target } })])

    const result = await fn({ url: 'https://example.test/?s=dior', guard })

    expect(result.status).toBe(302)
    expect(result.location).toBe(target)
    expect(result.attempts).toBe(1)
    expect(calls).toHaveLength(1) // a 3xx is returned, never chased
  })

  it('200 without Location → result.location is null', async () => {
    const guard = newGuard()
    const { fn } = fetcher([resp(200, '<html>ok</html>')])

    const result = await fn({ url: 'https://example.test/', guard })

    expect(result.location).toBeNull()
  })

  it('Location delivered as a string[] → takes the first entry', async () => {
    const guard = newGuard()
    const first = 'https://example.test/first'
    const raw: RawResponse = {
      statusCode: 301,
      headers: { location: [first, 'https://example.test/second'] },
      body: bodyOf(Buffer.from('', 'utf8')),
    }
    const { fn } = fetcher([raw])

    const result = await fn({ url: 'https://example.test/', guard })

    expect(result.location).toBe(first)
  })
})
