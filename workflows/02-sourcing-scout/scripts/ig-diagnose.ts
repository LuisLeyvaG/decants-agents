/**
 * Sprint 3 Instagram DIAGNOSTIC — one-shot, MANUAL, NOT part of `npm test`.
 *
 *   node --import tsx 02-sourcing-scout/scripts/ig-diagnose.ts
 *   # (from the `workflows/` directory; reads BrightData secrets from ./.env)
 *
 * This is NOT the Instagram parser (that is 3.3 and depends on what this finds).
 * It makes 2 real fetches through the existing Bright Data wrapper — a public
 * HASHTAG page and a public PROFILE page — under a HARD $0.50 sub-limit, dumps
 * each full body to tmp/ (gitignored), and prints diagnostic signals so we can
 * decide HOW (and whether) IG is scrapeable for decant discovery in CDMX before
 * committing to a parser design.
 *
 * What it answers:
 *   - Login wall? (redirect to /accounts/login, "Inicia sesión", login form)
 *   - Data in embedded JSON? (<script type="application/json">, _sharedData,
 *     __additionalData, PolarisQueryPreloader, __NEXT_DATA__, ld+json)
 *   - Challenge / captcha / rate-limit markers?
 *   - Real content vs shell? (visible-text length, % of bytes inside <script>)
 *   - Does it differ between the two page TYPES (hashtag vs profile)?
 *
 * Both fetches are ROTATING. If one looks blocked, re-run THAT url in STICKY
 * mode for a 3rd fetch (still inside $0.50) — see the commented hint in main().
 * It writes NOTHING to any datastore and never prints the proxy password.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import { CostGuard, CostGuardTrippedError } from './cost-guard.js'
import { createBrightDataFetcher, type BrightDataResult } from './brightdata-fetch.js'

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
// Hashtag relevant to CDMX decant discovery + a public seller profile. The
// profile handle is isolated here so it's trivial to swap.
const IG_HASHTAG = 'decantscdmx'
const IG_PROFILE_HANDLE = 'essential_scent_' // confirm/adjust this handle as needed

const HASHTAG_URL = `https://www.instagram.com/explore/tags/${IG_HASHTAG}/`
const PROFILE_URL = `https://www.instagram.com/${IG_PROFILE_HANDLE}/`

const SMOKE_BUDGET_USD = 0.5
const TMP_DIR = new URL('../tmp/', import.meta.url) // 02-sourcing-scout/tmp/

// --- analysis helpers -------------------------------------------------------
function count(haystack: string, needle: string, ci = false): number {
  const h = ci ? haystack.toLowerCase() : haystack
  const n = ci ? needle.toLowerCase() : needle
  if (!n) return 0
  return h.split(n).length - 1
}

interface ScriptBlock {
  readonly attrs: string
  readonly len: number
}

function extractScripts(body: string): ScriptBlock[] {
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
  const out: ScriptBlock[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    out.push({ attrs: (m[1] ?? '').trim(), len: (m[2] ?? '').length })
  }
  return out
}

function visibleTextLength(body: string): number {
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length
}

// IG login-wall markers: a redirect target, the localized + English prompts, and
// the login form id IG serves to anonymous clients.
const LOGIN_WALL_MARKERS = [
  '/accounts/login',
  'Inicia sesión',
  'Iniciar sesión',
  'Log in',
  'loginForm',
  'Sign up',
]
// Where IG historically embeds page data for anonymous/SSR rendering.
const STATE_MARKERS = [
  '<script type="application/json"',
  'window._sharedData',
  '_sharedData',
  '__additionalData',
  'PolarisQueryPreloader',
  '__NEXT_DATA__',
  'application/ld+json',
]
const ANTIBOT_MARKERS = [
  'captcha',
  'challenge',
  'checkpoint',
  'rate limit',
  'try again later',
  'unusual activity',
  'Please wait a few minutes',
  'HttpError',
]

function analyze(label: string, url: string, result: BrightDataResult): void {
  const body = result.body
  const scripts = extractScripts(body)
  const scriptBytes = scripts.reduce((a, s) => a + s.len, 0)
  const visible = visibleTextLength(body)

  console.log(`\n========== ${label} (${url}) ==========`)
  console.log(`status=${result.status} attempts=${result.attempts} sessionId=${result.sessionId ?? '(rotating)'}`)
  console.log(
    `body: ${body.length} chars | visible text: ${visible} | <script> tags: ${scripts.length} | script bytes: ${scriptBytes} (${((scriptBytes / Math.max(1, body.length)) * 100).toFixed(0)}% of HTML)`,
  )

  console.log('-- login-wall markers (occurrences) --')
  for (const mk of LOGIN_WALL_MARKERS) {
    const c = count(body, mk, true)
    if (c > 0) console.log(`   ${mk.padEnd(20)} ${c}`)
  }

  console.log('-- embedded-state / JSON markers (occurrences) --')
  for (const mk of STATE_MARKERS) console.log(`   ${mk.padEnd(30)} ${count(body, mk)}`)

  // Largest JSON-typed <script> block — the candidate data payload to parse.
  const jsonish = scripts
    .filter((s) => /json/i.test(s.attrs))
    .sort((a, b) => b.len - a.len)
  if (jsonish.length > 0) {
    console.log(
      `-- JSON-typed <script> blocks: ${jsonish.length}; largest ${jsonish[0]!.len} chars; attrs="${jsonish[0]!.attrs.slice(0, 80)}"`,
    )
  } else {
    console.log('-- JSON-typed <script> blocks: none')
  }

  console.log('-- anti-bot / challenge markers (occurrences) --')
  let antibotHits = 0
  for (const mk of ANTIBOT_MARKERS) {
    const c = count(body, mk, true)
    if (c > 0) {
      antibotHits += c
      console.log(`   ${mk.padEnd(22)} ${c}`)
    }
  }

  const loginHits = LOGIN_WALL_MARKERS.reduce((a, mk) => a + count(body, mk, true), 0)
  const hasState = jsonish.some((s) => s.len > 5000)
  const hint =
    result.status >= 400 || antibotHits > 0
      ? 'SIGNAL → blocked/challenged: check anti-bot markers + tmp/ body.'
      : hasState
        ? 'SIGNAL → large embedded JSON present: likely parseable without a headless browser.'
        : loginHits > 0
          ? 'SIGNAL → login wall: anonymous fetch returns a login gate, little/no data.'
          : 'SIGNAL → neither rich JSON nor an obvious login wall: inspect tmp/ body manually.'
  console.log(hint)
}

async function fetchVariant(
  brightDataFetch: ReturnType<typeof createBrightDataFetcher>,
  guard: CostGuard,
  label: string,
  url: string,
  sticky: boolean,
  filename: string,
): Promise<BrightDataResult | null> {
  try {
    // maxRetries:1 — a hard failure surfaces its real (redacted) reason instead
    // of burning attempts until the breaker trips (same rationale as the smoke).
    const result = await brightDataFetch({ url, sticky, guard, maxRetries: 1 })
    const out = new URL(filename, TMP_DIR)
    writeFileSync(out, result.body, 'utf8')
    console.log(`[ig-diagnose] ${label}: wrote full body → ${out.pathname}`)
    return result
  } catch (err) {
    if (err instanceof CostGuardTrippedError) {
      console.error(`[ig-diagnose] ${label}: CostGuard tripped (${err.reason}): ${err.message}`)
    } else {
      console.error(`[ig-diagnose] ${label}: fetch failed: ${(err as Error).message}`)
    }
    return null
  }
}

async function main(): Promise<void> {
  const envSource = loadDotEnv()
  console.log(`[ig-diagnose] env source: ${envSource ?? '(no .env — relying on process.env)'}`)
  console.log(`[ig-diagnose] hashtag: ${HASHTAG_URL}`)
  console.log(`[ig-diagnose] profile: ${PROFILE_URL}`)
  console.log(`[ig-diagnose] shared hard budget: $${SMOKE_BUDGET_USD.toFixed(2)}\n`)

  mkdirSync(TMP_DIR, { recursive: true })

  // One shared guard across both fetches, so $0.50 covers the whole diagnostic.
  const guard = new CostGuard({ maxSpendUsd: SMOKE_BUDGET_USD, costPerGbUsd: 8.0, maxConsecutiveFailures: 3 })
  const brightDataFetch = createBrightDataFetcher()

  // Both ROTATING. If either looks blocked/login-walled, re-run JUST that url in
  // STICKY mode for a 3rd fetch (still under $0.50), e.g.:
  //   const retry = await fetchVariant(brightDataFetch, guard, 'HASHTAG-STICKY', HASHTAG_URL, true, 'ig-sample-hashtag-sticky.html')
  const hashtag = await fetchVariant(brightDataFetch, guard, 'HASHTAG', HASHTAG_URL, false, 'ig-sample-hashtag.html')
  const profile = await fetchVariant(brightDataFetch, guard, 'PROFILE', PROFILE_URL, false, 'ig-sample-profile.html')

  if (hashtag) analyze('HASHTAG', HASHTAG_URL, hashtag)
  if (profile) analyze('PROFILE', PROFILE_URL, profile)

  if (hashtag && profile) {
    console.log('\n========== HASHTAG vs PROFILE ==========')
    console.log(
      `body chars: hashtag=${hashtag.body.length}  profile=${profile.body.length}  Δ=${profile.body.length - hashtag.body.length}`,
    )
    const stateDelta = STATE_MARKERS.map(
      (mk) => `${mk.slice(0, 24)}:${count(profile.body, mk) - count(hashtag.body, mk)}`,
    ).join('  ')
    console.log(`embedded-state marker delta (profile - hashtag): ${stateDelta}`)
  }

  console.log(`\n[ig-diagnose] guard snapshot: ${JSON.stringify(guard.snapshot())}`)
  console.log('[ig-diagnose] inspect the dumped HTML in 02-sourcing-scout/tmp/ for the full picture.')
}

void main()
