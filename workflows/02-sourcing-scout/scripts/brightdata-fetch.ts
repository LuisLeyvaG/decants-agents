/**
 * Bright Data residential-proxy fetch wrapper for Agente 2 (Sourcing Scout).
 *
 * Bright Data's product here is RESIDENTIAL PROXIES — an HTTP proxy with CONNECT
 * tunnelling, NOT a REST API. We reach the gateway `brd.superproxy.io:33335`
 * through `undici.ProxyAgent` and speak directly to it (the n8n VM's egress IP
 * is allowlisted; we must NOT route through any egress proxy). Cost is billed at
 * $/GB on REAL bytes transferred, so every byte is accounted into an injected
 * `CostGuard` which can trip the run.
 *
 * --- BYTE ACCOUNTING (read this before touching the counting logic) ----------
 * We measure ON-WIRE bytes (what Bright Data actually bills), not the decoded
 * payload:
 *   - Response BODY: counted EXACTLY as the compressed bytes that arrive over
 *     the socket (Σ chunk.length). We use undici's low-level `request()` rather
 *     than `fetch()` precisely because `request()` does NOT auto-decompress —
 *     the body we count is the gzip/br bytes on the wire. We decompress
 *     ourselves (node:zlib) only to produce the returned `body` string.
 *   - We deliberately do NOT force `Accept-Encoding: identity`; letting the
 *     server gzip the HTML is what keeps the wire (and the bill) small. Counting
 *     the decompressed body would overcount ~3-4x and trip the guard early.
 *   - HEADERS (request line + request headers + response status line + response
 *     headers): ESTIMATED, intentionally rounded UP via `HEADER_OVERHEAD_BYTES`.
 *     A cost guard that UNDERcounts spends real money without tripping, so the
 *     estimate errs high on purpose. Only the body is exact; headers are a
 *     conservative over-estimate.
 *
 * --- SECURITY ----------------------------------------------------------------
 * The proxy URL embeds `http://<user>:<password>@gateway`. undici errors on a
 * failed CONNECT can include that full URL. Every error leaving this module is
 * passed through `redactSecrets()` so the password never reaches a log or a
 * propagated stack.
 *
 * --- TESTABILITY -------------------------------------------------------------
 * No real network in tests. `createBrightDataFetcher` takes injectable deps
 * (`requestImpl`, `sleep`, `generateSessionId`, `env`); tests pass a fake
 * `requestImpl`. The default `requestImpl` is the only place that imports the
 * real undici and opens a socket.
 */

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  brotliDecompressSync,
  gunzipSync,
  inflateRawSync,
  inflateSync,
} from 'node:zlib'

import { CostGuard, CostGuardTrippedError } from './cost-guard.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BrightDataFetchOptions {
  /** Absolute URL to fetch through the proxy. */
  readonly url: string
  /** When true, pin to one residential IP by appending `-session-<id>` to the username. */
  readonly sticky?: boolean
  /** Explicit sticky session id; auto-generated when `sticky` and omitted. Ignored when not sticky. */
  readonly sessionId?: string
  /** Injected accountant/breaker. Asserted before each attempt; bytes/outcome recorded after. */
  readonly guard: CostGuard
  /** Per-attempt timeout. Default 30000 ms. */
  readonly timeoutMs?: number
  /** Max retries AFTER the first attempt (total attempts ≤ maxRetries + 1). Default 3. */
  readonly maxRetries?: number
}

export interface BrightDataResult {
  /** HTTP status of the final attempt. */
  readonly status: number
  /** Decompressed response body as UTF-8 text. */
  readonly body: string
  /** On-wire bytes this call recorded into the guard (exact body + conservative header estimate). */
  readonly bytesTransferred: number
  /** Number of attempts made (1 + retries used). */
  readonly attempts: number
  /** The sticky session id used, or null when rotating. */
  readonly sessionId: string | null
}

/** Minimal shape of a proxied HTTP response — undici's `request` result maps onto it. */
export interface RawResponse {
  readonly statusCode: number
  readonly headers: Record<string, string | string[] | undefined>
  /** Raw (NOT decompressed) response body chunks, exactly as received on the wire. */
  readonly body: AsyncIterable<Buffer | Uint8Array>
}

/** Options the wrapper hands to the request implementation for a single attempt. */
export interface RequestImplOptions {
  readonly method: 'GET'
  readonly headers: Record<string, string>
  readonly signal: AbortSignal
  /** Full proxy URL incl. credentials: `http://<user>:<pass>@host:port`. */
  readonly proxyUrl: string
  /** The proxy username for this attempt (carries `-session-<id>` when sticky) — convenient for assertions. */
  readonly proxyUsername: string
  /**
   * Bright Data's zone SSL-inspection CA, in PEM. The default impl passes this
   * to the ProxyAgent's `requestTls.ca` so Bright Data's self-signed root is
   * trusted ONLY for this dispatcher's traffic — never added to Node's global
   * trust store (which would make every other client in the process — Postgres,
   * OpenAI, Maps, Medusa — trust it too).
   */
  readonly caCert: string
}

export type RequestImpl = (url: string, options: RequestImplOptions) => Promise<RawResponse>

export interface BrightDataFetcherDeps {
  /** Defaults to the real undici-backed implementation. Override in tests. */
  readonly requestImpl?: RequestImpl
  /** Defaults to a real timer. Override with a no-op in tests to skip backoff waits. */
  readonly sleep?: (ms: number) => Promise<void>
  /** Defaults to a crypto-random hex id. */
  readonly generateSessionId?: () => string
  /** Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** Reads the CA cert file at the given path. Defaults to a UTF-8 `readFileSync`. Override in tests. */
  readonly readCaFile?: (path: string) => string
}

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/**
 * Conservative flat estimate for everything that is NOT the response body:
 * request line + request headers + response status line + response headers.
 * 2 KiB comfortably exceeds a realistic HTTP/1.1 header block, and overcounting
 * is the SAFE direction for a cost guard (it trips early rather than overspending).
 * The response body is counted exactly elsewhere; only this overhead is estimated.
 */
export const HEADER_OVERHEAD_BYTES = 2048

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RETRIES = 3
const BACKOFF_BASE_MS = 500
const BACKOFF_CAP_MS = 8_000

/** Realistic recent desktop User-Agents; one is chosen per attempt to vary the fingerprint. */
export const USER_AGENTS: readonly string[] = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
]

// ---------------------------------------------------------------------------
// Env / username / proxy-url construction
// ---------------------------------------------------------------------------

/**
 * Bright Data residential username format:
 *   brd-customer-hl_<id>-zone-<zone>[-session-<sessionId>]
 * e.g. `brd-customer-hl_ee9d698f-zone-leyvascents_mx` (rotating) or
 *      `brd-customer-hl_ee9d698f-zone-leyvascents_mx-session-ab12cd` (sticky).
 * Appending `-session-<id>` pins the request to a single residential IP for the
 * life of that session; omitting it rotates the IP per request.
 */
function buildProxyUsername(baseUsername: string, sticky: boolean, sessionId: string | null): string {
  return sticky && sessionId !== null ? `${baseUsername}-session-${sessionId}` : baseUsername
}

/** Accept either `host:port` or `http(s)://host:port` and return the bare host/port. */
function parseEndpoint(endpoint: string): { host: string; port: string } {
  const cleaned = endpoint.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  const idx = cleaned.lastIndexOf(':')
  if (idx <= 0 || idx === cleaned.length - 1) {
    throw new Error(`BRIGHTDATA_ENDPOINT must be "host:port", got "${endpoint}"`)
  }
  return { host: cleaned.slice(0, idx), port: cleaned.slice(idx + 1) }
}

interface ResolvedConfig {
  readonly host: string
  readonly port: string
  readonly baseUsername: string
  readonly password: string
  /** Bright Data zone SSL-inspection CA in PEM (scoped to the ProxyAgent only). */
  readonly caCert: string
}

/**
 * Read + validate the Bright Data config from env at construction. Throws
 * (listing all missing) so a misconfiguration fails up front, not mid paid run.
 *
 * `BRIGHTDATA_CA_CERT` is the path to Bright Data's zone SSL-inspection CA.
 * Bright Data terminates TLS at the super-proxy and presents its own root, so
 * without this CA every HTTPS fetch fails with SELF_SIGNED_CERT_IN_CHAIN. We
 * REQUIRE it and trust it ONLY for proxy traffic (see `requestTls.ca`). There is
 * deliberately NO insecure fallback: a missing/unreadable CA is a hard error.
 */
function resolveConfig(env: NodeJS.ProcessEnv, readCaFile: (path: string) => string): ResolvedConfig {
  const required = [
    'BRIGHTDATA_ENDPOINT',
    'BRIGHTDATA_USERNAME',
    'BRIGHTDATA_PASSWORD',
    'BRIGHTDATA_CA_CERT',
  ] as const
  const missing = required.filter((k) => {
    const v = env[k]
    return v === undefined || v.trim() === ''
  })
  if (missing.length > 0) {
    throw new Error(
      `brightDataFetch: missing required env var(s): ${missing.join(', ')}. ` +
        `Set them from a local .env (see .env.example) or via n8n / GCP Secret Manager. ` +
        `BRIGHTDATA_CA_CERT must point to Bright Data's SSL-inspection CA for port 33335 ` +
        `(dashboard → zone leyvascents_mx → "Load our SSL certificate in your code", ` +
        `or github.com/luminati-io/ssl-certificate). It is loaded into the code (ProxyAgent ` +
        `requestTls.ca), NOT installed in the OS trust store.`,
    )
  }

  const { host, port } = parseEndpoint(env.BRIGHTDATA_ENDPOINT as string)

  const caPath = (env.BRIGHTDATA_CA_CERT as string).trim()
  let caCert: string
  try {
    caCert = readCaFile(caPath)
  } catch (e) {
    throw new Error(
      `brightDataFetch: could not read Bright Data CA cert from BRIGHTDATA_CA_CERT="${caPath}": ` +
        `${(e as Error).message}. Get the port-33335 CA from the Bright Data dashboard ` +
        `(zone leyvascents_mx → "Load our SSL certificate in your code") or github.com/luminati-io/ssl-certificate, ` +
        `save it, and point BRIGHTDATA_CA_CERT at the .crt. This CA is trusted ONLY for proxy traffic ` +
        `(ProxyAgent requestTls.ca); the wrapper will NOT fall back to insecure TLS.`,
    )
  }
  if (caCert.trim() === '') {
    throw new Error(
      `brightDataFetch: Bright Data CA cert at BRIGHTDATA_CA_CERT="${caPath}" is empty. ` +
        `Re-download it from the Bright Data dashboard (zone leyvascents_mx → "SSL certificate").`,
    )
  }

  return {
    host,
    port,
    baseUsername: (env.BRIGHTDATA_USERNAME as string).trim(),
    password: env.BRIGHTDATA_PASSWORD as string,
    caCert,
  }
}

function buildProxyUrl(cfg: ResolvedConfig, proxyUsername: string): string {
  // encodeURIComponent on the userinfo so special characters in the password
  // (e.g. `@`, `:`) cannot corrupt the URL or leak an extra `@host`.
  return `http://${encodeURIComponent(proxyUsername)}:${encodeURIComponent(cfg.password)}@${cfg.host}:${cfg.port}`
}

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

/**
 * Replace every occurrence of the proxy password (raw and URL-encoded forms)
 * with `***` in an arbitrary string. Used on everything that could be logged or
 * thrown, so a failed CONNECT error carrying the proxy URL never leaks creds.
 */
export function redactSecrets(text: string, password: string): string {
  if (!password) return text
  let out = text
  for (const secret of new Set([password, encodeURIComponent(password)])) {
    if (secret) out = out.split(secret).join('***')
  }
  return out
}

/**
 * Flatten an error chain into one human-readable string: message, `code` (undici
 * puts `ECONNREFUSED`/`ENOTFOUND`/etc. here) and the nested `cause` (undici puts
 * the real CONNECT/TLS/proxy-auth reason here). Without this, a failed proxy
 * CONNECT surfaces only a generic top-level message and the real reason is lost.
 */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const parts = [err.message]
  const code = (err as { code?: unknown }).code
  if (code !== undefined) parts.push(`[code=${String(code)}]`)
  if (err.cause !== undefined) parts.push(`caused by: ${describeError(err.cause)}`)
  return parts.join(' ')
}

/** Sanitize an Error (flattened message + stack) so no secret survives propagation. */
function redactError(err: unknown, password: string): Error {
  const safe = new Error(redactSecrets(describeError(err), password))
  safe.name = err instanceof Error ? err.name : 'Error'
  if (err instanceof Error && err.stack) safe.stack = redactSecrets(err.stack, password)
  return safe
}

// ---------------------------------------------------------------------------
// Body reading + decompression
// ---------------------------------------------------------------------------

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] : v
  }
  return undefined
}

/**
 * Decompress per `content-encoding`, degrading gracefully:
 *   - absent / `identity` → raw bytes as UTF-8 text.
 *   - unknown encoding     → raw bytes as-is + a warning (no crash).
 *   - known but corrupt    → raw bytes as-is + a warning (no crash).
 * ML / captcha pages sometimes arrive uncompressed, so this must never throw.
 */
function decompressBody(
  raw: Buffer,
  headers: Record<string, string | string[] | undefined>,
): string {
  const enc = headerValue(headers, 'content-encoding')?.trim().toLowerCase()
  if (!enc || enc === 'identity') return raw.toString('utf8')
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return gunzipSync(raw).toString('utf8')
    if (enc === 'br') return brotliDecompressSync(raw).toString('utf8')
    if (enc === 'deflate') {
      try {
        return inflateSync(raw).toString('utf8')
      } catch {
        return inflateRawSync(raw).toString('utf8') // raw-deflate fallback
      }
    }
    console.warn(`[brightdata-fetch] unknown content-encoding "${enc}"; using body as-is`)
    return raw.toString('utf8')
  } catch (e) {
    console.warn(
      `[brightdata-fetch] failed to decompress "${enc}" body; using raw bytes as-is: ${(e as Error).message}`,
    )
    return raw.toString('utf8')
  }
}

/** Drain the raw body, counting exact on-wire (compressed) bytes, then decompress. */
async function readBody(res: RawResponse): Promise<{ bytesOnWire: number; bodyText: string }> {
  const chunks: Buffer[] = []
  let bytesOnWire = 0
  for await (const chunk of res.body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytesOnWire += buf.length
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks)
  return { bytesOnWire, bodyText: decompressBody(raw, res.headers) }
}

// ---------------------------------------------------------------------------
// Default (real) request implementation — the only network-touching code
// ---------------------------------------------------------------------------

function oneChunkIterable(buf: Buffer): AsyncIterable<Buffer> {
  return {
    async *[Symbol.asyncIterator]() {
      yield buf
    },
  }
}

/**
 * Real implementation: open a CONNECT tunnel through Bright Data via
 * `undici.ProxyAgent`, buffer the raw (still-compressed) body, then close the
 * dispatcher so the process can exit. undici's `request()` does NOT decompress,
 * so the buffered bytes equal the wire bytes.
 */
const defaultRequestImpl: RequestImpl = async (url, options) => {
  const { request, ProxyAgent } = await import('undici')
  // `requestTls` configures the TLS handshake to the TARGET (through the tunnel).
  // Scoping Bright Data's inspection CA here trusts it ONLY for this dispatcher's
  // traffic — NOT globally (unlike NODE_EXTRA_CA_CERTS, which the rest of the
  // process — Postgres/OpenAI/Maps/Medusa — would inherit).
  const dispatcher = new ProxyAgent({
    uri: options.proxyUrl,
    requestTls: { ca: options.caCert },
  })
  try {
    const res = await request(url, {
      method: options.method,
      headers: options.headers,
      dispatcher,
      signal: options.signal,
    })
    const chunks: Buffer[] = []
    for await (const c of res.body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
    return {
      statusCode: res.statusCode,
      headers: res.headers as Record<string, string | string[] | undefined>,
      body: oneChunkIterable(Buffer.concat(chunks)),
    }
  } finally {
    await dispatcher.close().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Retry helpers
// ---------------------------------------------------------------------------

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defaultSessionId(): string {
  return randomBytes(6).toString('hex')
}

/** Exponential backoff with full jitter, capped. `attempt` is the attempt that just failed (1-based). */
function backoffDelayMs(attempt: number): number {
  const expo = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1))
  return expo + Math.random() * BACKOFF_BASE_MS
}

/** A status that warrants a retry: transient server errors and rate limiting. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

function pickUserAgent(attempt: number): string {
  // Vary by attempt without RNG dependence in tests; pool is non-empty.
  return USER_AGENTS[(attempt - 1) % USER_AGENTS.length] as string
}

function buildHeaders(attempt: number): Record<string, string> {
  return {
    'user-agent': pickUserAgent(attempt),
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'es-MX,es;q=0.9',
    'accept-encoding': 'gzip, deflate, br', // let the server compress — keeps wire bytes (and cost) low
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a `brightDataFetch` bound to validated env + injected deps. The env is
 * read and validated HERE (at construction) so a missing secret fails loudly up
 * front rather than midway through a paid run.
 */
export function createBrightDataFetcher(
  deps: BrightDataFetcherDeps = {},
): (opts: BrightDataFetchOptions) => Promise<BrightDataResult> {
  const readCaFile = deps.readCaFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const cfg = resolveConfig(deps.env ?? process.env, readCaFile)
  const requestImpl = deps.requestImpl ?? defaultRequestImpl
  const sleep = deps.sleep ?? defaultSleep
  const generateSessionId = deps.generateSessionId ?? defaultSessionId

  return async function brightDataFetch(opts: BrightDataFetchOptions): Promise<BrightDataResult> {
    const { url, guard } = opts
    const sticky = opts.sticky ?? false
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES

    const sessionId = sticky ? opts.sessionId ?? generateSessionId() : null
    const proxyUsername = buildProxyUsername(cfg.baseUsername, sticky, sessionId)
    const proxyUrl = buildProxyUrl(cfg, proxyUsername)

    let attempt = 0
    let bytesThisCall = 0

    while (true) {
      attempt += 1

      // BEFORE every attempt. CostGuardTrippedError is NOT caught here — it
      // propagates so the caller aborts the run (budget) or degrades (failures).
      guard.assertCanProceed()

      try {
        const res = await requestImpl(url, {
          method: 'GET',
          headers: buildHeaders(attempt),
          signal: AbortSignal.timeout(timeoutMs),
          proxyUrl,
          proxyUsername,
          caCert: cfg.caCert,
        })

        const { bytesOnWire, bodyText } = await readBody(res)
        const attemptBytes = HEADER_OVERHEAD_BYTES + bytesOnWire
        guard.recordBytes(attemptBytes)
        bytesThisCall += attemptBytes

        const status = res.statusCode

        if (!isRetryableStatus(status)) {
          // Definitive response. <400 is usable (success); 4xx (e.g. 404) is a
          // non-retryable failure but still returned with its status/body.
          if (status < 400) guard.recordSuccess()
          else guard.recordFailure()
          return { status, body: bodyText, bytesTransferred: bytesThisCall, attempts: attempt, sessionId }
        }

        // Retryable status (5xx / 429): count the failure, retry if budget of
        // retries remains, else return the last bad response.
        guard.recordFailure()
        if (attempt > maxRetries) {
          return { status, body: bodyText, bytesTransferred: bytesThisCall, attempts: attempt, sessionId }
        }
        await sleep(backoffDelayMs(attempt))
        continue
      } catch (err) {
        // A guard trip must never be swallowed as a network error.
        if (err instanceof CostGuardTrippedError) throw err

        // Network error / timeout / abort: the request bytes still hit the wire,
        // so record the conservative uplink overhead, then count the failure.
        guard.recordBytes(HEADER_OVERHEAD_BYTES)
        bytesThisCall += HEADER_OVERHEAD_BYTES
        guard.recordFailure()

        if (attempt > maxRetries) {
          throw redactError(err, cfg.password) // never leak the proxy password
        }
        await sleep(backoffDelayMs(attempt))
        continue
      }
    }
  }
}
