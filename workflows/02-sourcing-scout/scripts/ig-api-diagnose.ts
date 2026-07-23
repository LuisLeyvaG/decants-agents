/**
 * Sprint 3 — Instagram INTERNAL-API diagnostic (option A). One-shot, MANUAL,
 * NOT part of `npm test`. NOT the IG parser (3.3 depends on this result).
 *
 *   node --import tsx 02-sourcing-scout/scripts/ig-api-diagnose.ts
 *   # (from the `workflows/` directory; reads BrightData secrets from ./.env)
 *
 * The disk inspector proved the initial HTML is a logged-out `httpErrorPage`
 * shell with ZERO entity data — the SPA loads the real data from IG's internal
 * endpoints afterwards. This script tests whether those endpoints answer a
 * LOGGED-OUT request through Bright Data (residential), i.e. without any cookie/
 * session (option B — authenticated account — is DISCARDED; not implemented here).
 *
 *   1. web_profile_info  → profile bio / counts / posts / contact
 *   2. tags/web_info     → hashtag top/recent media
 *
 * --- WHY A CUSTOM requestImpl (and why this does NOT touch the frozen wrapper) -
 * `brightdata-fetch.ts` is frozen (Sprint 2) and its options expose no custom-
 * header hook — `buildHeaders()` is internal and sends `accept: text/html`. IG's
 * internal API REQUIRES `x-ig-app-id` and rejects an HTML Accept. The wrapper
 * exposes `deps.requestImpl` precisely as its injectable network seam (it's how
 * the unit tests swap the socket). So we inject a requestImpl that REUSES the
 * wrapper unchanged — cost guard, exact on-wire byte accounting, password
 * redaction, scoped CA, retry/backoff all still run in the wrapper — and only
 * MERGES the extra request headers on top of the ones the wrapper built (so the
 * pool User-Agent the wrapper picked per attempt is preserved). We do NOT edit
 * brightdata-fetch.ts or cost-guard.ts; this is their public extension point.
 *
 * Like the wrapper's own default impl, this requestImpl does NOT decompress the
 * body — it returns the raw on-wire (gzip/br) bytes so the wrapper's byte
 * accounting stays exact; the wrapper decompresses for the returned text.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import { CostGuard, CostGuardTrippedError } from './cost-guard.js'
import {
  createBrightDataFetcher,
  type BrightDataResult,
  type RequestImpl,
} from './brightdata-fetch.js'

// --- minimal .env loader (no dotenv dep) -----------------------------------
function loadDotEnv(): string | null {
  const candidate = new URL('../../.env', import.meta.url) // workflows/.env
  let raw: string
  try {
    raw = readFileSync(candidate, 'utf8')
  } catch {
    return null
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
  return candidate.pathname
}

// --- targets ----------------------------------------------------------------
/** Instagram WEB app id — the value the SPA itself sends as `x-ig-app-id`.
 *  Extracted from the dumped HTML (`"appId":936619743392459`). Without it IG's
 *  internal API returns 401/403 to web clients. NOT a secret (it's the public
 *  web client id baked into instagram.com). */
const IG_APP_ID = '936619743392459'

const PROFILE_HANDLE = 'essential_scent_' // real CDMX decant seller (confirmed)
const HASHTAG = 'decantscdmx'

const PROFILE_URL = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${PROFILE_HANDLE}`
const HASHTAG_URL = `https://www.instagram.com/api/v1/tags/web_info/?tag_name=${HASHTAG}`

const SMOKE_BUDGET_USD = 0.5
const TMP_DIR = new URL('../tmp/', import.meta.url) // 02-sourcing-scout/tmp/

// ---------------------------------------------------------------------------
// Custom requestImpl: wrapper-built headers + the IG-specific ones merged on top
// ---------------------------------------------------------------------------

function oneChunkIterable(buf: Buffer): AsyncIterable<Buffer> {
  return {
    async *[Symbol.asyncIterator]() {
      yield buf
    },
  }
}

const igApiRequestImpl: RequestImpl = async (url, options) => {
  const { request, ProxyAgent } = await import('undici')
  // Same scoped-CA ProxyAgent the wrapper's default impl builds (CA trusted ONLY
  // for this dispatcher, never globally). proxyUrl + caCert come from the wrapper.
  const dispatcher = new ProxyAgent({ uri: options.proxyUrl, requestTls: { ca: options.caCert } })
  try {
    const res = await request(url, {
      method: options.method,
      headers: {
        // Base = what the wrapper built (incl. the per-attempt pool User-Agent
        // and accept-encoding that keeps wire bytes/cost low).
        ...options.headers,
        // Override/add the headers that make this look like the SPA's own XHR:
        accept: 'application/json', // these endpoints return JSON, not HTML; IG 4xx's an HTML Accept
        'x-ig-app-id': IG_APP_ID, // REQUIRED: identifies the IG web client; missing ⇒ 401/403
        'x-requested-with': 'XMLHttpRequest', // marks an AJAX/XHR call, as the SPA's fetch does
        referer: 'https://www.instagram.com/', // same-origin referer IG checks on internal endpoints
        'x-ig-www-claim': '0', // SPA sends this; '0' is the valid "no claim yet" value for a fresh client
      },
      dispatcher,
      signal: options.signal,
    })
    // Buffer raw (still-compressed) bytes; do NOT decompress (wrapper does + counts).
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
// Analysis helpers
// ---------------------------------------------------------------------------

function shapeOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return `Array(${v.length})`
  if (typeof v === 'object') return `object{${Object.keys(v as object).length}}`
  if (typeof v === 'string') return `string(${(v as string).length})`
  return typeof v
}

/** Depth-limited key map (bounded so a big payload can't flood stdout). */
function mapStructure(value: unknown, depth = 0, maxDepth = 2, keyCap = 30): string[] {
  const pad = '  '.repeat(depth)
  const lines: string[] = []
  if (Array.isArray(value)) {
    lines.push(`${pad}Array(${value.length})`)
    if (depth < maxDepth && value.length > 0) lines.push(...mapStructure(value[0], depth + 1, maxDepth, keyCap))
    return lines
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
    for (const k of keys.slice(0, keyCap)) {
      lines.push(`${pad}${k}: ${shapeOf(obj[k])}`)
      if (depth < maxDepth && obj[k] && typeof obj[k] === 'object') {
        lines.push(...mapStructure(obj[k], depth + 1, maxDepth, keyCap))
      }
    }
    if (keys.length > keyCap) lines.push(`${pad}… (+${keys.length - keyCap} more keys)`)
    return lines
  }
  lines.push(`${pad}${shapeOf(value)}`)
  return lines
}

/** Trim a value to a short, single-line, ~200-char example (NO mass dump). */
function sample(v: unknown, n = 200): string {
  if (v === undefined) return '(absent)'
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return (s ?? String(v)).replace(/\s+/g, ' ').slice(0, n)
}

function countOccurrences(haystack: string, needle: string): number {
  return needle ? haystack.split(needle).length - 1 : 0
}

const BLOCK_MARKERS = [
  'login_required',
  'checkpoint_required',
  'useragent mismatch',
  '"status": "fail"',
  '"status":"fail"',
  'require_login',
  'please wait a few minutes',
  'rate limit',
]

/** Returns a human reason if the response looks like a logged-out block, else null. */
function blockReason(status: number, bodyText: string): string | null {
  if (status === 401 || status === 403 || status === 429) return `HTTP ${status}`
  const lower = bodyText.toLowerCase()
  for (const m of BLOCK_MARKERS) if (lower.includes(m.toLowerCase())) return m
  return null
}

type Verdict = 'data' | 'blocked' | 'unknown'

// ---------------------------------------------------------------------------
// Per-endpoint reporting
// ---------------------------------------------------------------------------

interface Parsed {
  ok: boolean
  value: unknown
  error?: string
}

function tryParse(body: string): Parsed {
  try {
    return { ok: true, value: JSON.parse(body) }
  } catch (e) {
    return { ok: false, value: null, error: (e as Error).message }
  }
}

function reportProfile(parsed: unknown): { verdict: Verdict; lines: string[] } {
  const lines: string[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const user = (parsed as any)?.data?.user
  if (!user || typeof user !== 'object') {
    lines.push('   data.user: ABSENT (no profile entity in payload)')
    return { verdict: 'unknown', lines }
  }
  const fields: Array<[string, unknown]> = [
    ['biography', user.biography],
    ['full_name', user.full_name],
    ['edge_followed_by.count', user.edge_followed_by?.count],
    ['external_url', user.external_url],
    ['business_phone_number', user.business_phone_number],
    ['business_email', user.business_email],
    ['is_business_account', user.is_business_account],
    ['category_name', user.category_name],
  ]
  for (const [k, v] of fields) lines.push(`   user.${k}: ${sample(v)}`)

  const posts = user.edge_owner_to_timeline_media
  if (posts && typeof posts === 'object') {
    const first = posts.edges?.[0]?.node
    lines.push(
      `   user.edge_owner_to_timeline_media: count=${posts.count}, edges=${posts.edges?.length ?? 0}, firstShortcode=${first?.shortcode ?? '(none)'}`,
    )
  } else {
    lines.push('   user.edge_owner_to_timeline_media: (absent)')
  }

  // "Real entity data" = the identifying profile fields are actually present.
  const hasData =
    user.biography !== undefined || user.full_name !== undefined || posts !== undefined
  return { verdict: hasData ? 'data' : 'unknown', lines }
}

function reportHashtag(parsed: unknown, bodyText: string): { verdict: Verdict; lines: string[] } {
  const lines: string[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (parsed as any)?.data ?? parsed
  const candidates = ['name', 'id', 'media_count', 'top', 'recent', 'sections', 'edge_hashtag_to_media']
  let any = false
  for (const k of candidates) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = (data as any)?.[k]
    if (v !== undefined) {
      any = true
      lines.push(`   data.${k}: ${sample(v)}`)
    }
  }
  const shortcodeHits = countOccurrences(bodyText, '"shortcode"') + countOccurrences(bodyText, '"code"')
  lines.push(`   post markers in body: "shortcode"/"code" ×${shortcodeHits}`)
  if (!any) lines.push('   (no recognizable hashtag-media keys under data.*)')

  const hasData = any || shortcodeHits > 0
  return { verdict: hasData ? 'data' : 'unknown', lines }
}

function analyze(
  label: string,
  url: string,
  kind: 'profile' | 'hashtag',
  result: BrightDataResult,
): Verdict {
  console.log(`\n========== ${label} (${url}) ==========`)
  console.log(`status=${result.status} attempts=${result.attempts} sessionId=${result.sessionId ?? '(rotating)'}`)
  console.log(`body: ${result.body.length} chars (decompressed) | bytes on-wire+est: ${result.bytesTransferred}`)

  const block = blockReason(result.status, result.body)
  if (block) console.log(`-- BLOCK signal: ${block}`)

  const parsed = tryParse(result.body)
  if (!parsed.ok) {
    console.log(`-- body is NOT valid JSON: ${parsed.error}`)
    console.log(`-- first 200 chars: ${result.body.slice(0, 200).replace(/\s+/g, ' ')}`)
    return block ? 'blocked' : 'unknown'
  }

  console.log('-- top-level structure (depth 2) --')
  for (const line of mapStructure(parsed.value, 0, 2)) console.log(`   ${line}`)

  console.log('-- entity-data probe --')
  const { verdict, lines } = kind === 'profile' ? reportProfile(parsed.value) : reportHashtag(parsed.value, result.body)
  for (const l of lines) console.log(l)

  // A block marker overrides a (possibly partial) data read.
  if (block) return 'blocked'
  return verdict
}

// ---------------------------------------------------------------------------
// Fetch one endpoint
// ---------------------------------------------------------------------------

async function fetchVariant(
  fetcher: ReturnType<typeof createBrightDataFetcher>,
  guard: CostGuard,
  label: string,
  url: string,
  sticky: boolean,
  filename: string,
): Promise<BrightDataResult | null> {
  try {
    const result = await fetcher({ url, sticky, guard, maxRetries: 1 })
    writeFileSync(new URL(filename, TMP_DIR), result.body, 'utf8')
    console.log(`[ig-api] ${label}: wrote raw body → ${new URL(filename, TMP_DIR).pathname}`)
    return result
  } catch (err) {
    if (err instanceof CostGuardTrippedError) {
      console.error(`[ig-api] ${label}: CostGuard tripped (${err.reason}): ${err.message}`)
    } else {
      console.error(`[ig-api] ${label}: fetch failed: ${(err as Error).message}`) // already password-redacted by wrapper
    }
    return null
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const envSource = loadDotEnv()
  console.log(`[ig-api] env source: ${envSource ?? '(no .env — relying on process.env)'}`)
  console.log(`[ig-api] x-ig-app-id: ${IG_APP_ID}`)
  console.log(`[ig-api] profile: ${PROFILE_URL}`)
  console.log(`[ig-api] hashtag: ${HASHTAG_URL}`)
  console.log(`[ig-api] shared hard budget: $${SMOKE_BUDGET_USD.toFixed(2)}\n`)

  mkdirSync(TMP_DIR, { recursive: true })

  const guard = new CostGuard({ maxSpendUsd: SMOKE_BUDGET_USD, costPerGbUsd: 8.0, maxConsecutiveFailures: 3 })
  const fetcher = createBrightDataFetcher({ requestImpl: igApiRequestImpl })

  // Both ROTATING first.
  const profileRes = await fetchVariant(fetcher, guard, 'PROFILE', PROFILE_URL, false, 'ig-api-profile.json')
  const hashtagRes = await fetchVariant(fetcher, guard, 'HASHTAG', HASHTAG_URL, false, 'ig-api-hashtag.json')

  let profileVerdict: Verdict = 'unknown'
  let hashtagVerdict: Verdict = 'unknown'
  if (profileRes) profileVerdict = analyze('PROFILE', PROFILE_URL, 'profile', profileRes)
  if (hashtagRes) hashtagVerdict = analyze('HASHTAG', HASHTAG_URL, 'hashtag', hashtagRes)

  // If a rotating fetch was blocked, a STABLE (sticky) residential IP SOMETIMES
  // passes where a fresh rotating IP is flagged. Re-run JUST ONE in sticky to
  // test that — DO NOT run without explicit OK (stays within the $0.50 guard):
  //   const profileSticky = await fetchVariant(fetcher, guard, 'PROFILE-STICKY', PROFILE_URL, true, 'ig-api-profile-sticky.json')
  //   if (profileSticky) profileVerdict = analyze('PROFILE-STICKY', PROFILE_URL, 'profile', profileSticky)

  console.log(`\n========== VERDICT ==========`)
  console.log(`profile (web_profile_info): ${profileVerdict}`)
  console.log(`hashtag (tags/web_info):    ${hashtagVerdict}`)

  let verdict: string
  if (profileVerdict === 'data' && hashtagVerdict === 'data') {
    verdict = 'IG-API VIABLE logged-out — ambos endpoints devuelven datos reales.'
  } else if (profileVerdict === 'data' && hashtagVerdict !== 'data') {
    verdict =
      'MIXTO — perfil SÍ, hashtag NO. IG descubre por perfiles conocidos (web_profile_info), no por hashtag.'
  } else if (hashtagVerdict === 'data' && profileVerdict !== 'data') {
    verdict = 'MIXTO — hashtag SÍ, perfil NO. Descubrimiento por hashtag viable; perfil bloqueado.'
  } else if (profileVerdict === 'blocked' && hashtagVerdict === 'blocked') {
    verdict = 'IG-API BLOQUEADO logged-out — ambos devuelven login_required/checkpoint/4xx.'
  } else {
    verdict =
      'INCONCLUSO — ni datos claros ni bloqueo explícito en al menos uno; revisa los JSON en tmp/. ' +
      'Considera el reintento sticky comentado en main().'
  }
  console.log(`\n>>> ${verdict}`)

  console.log(`\n[ig-api] guard snapshot: ${JSON.stringify(guard.snapshot())}`)
  console.log('[ig-api] raw bodies dumped to 02-sourcing-scout/tmp/ig-api-*.json for manual inspection.')
}

void main()
