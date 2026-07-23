/**
 * Sprint 2 content diagnostic — one-shot, MANUAL, NOT part of `npm test`.
 *
 *   node --import tsx 02-sourcing-scout/scripts/smoke-diagnose.ts
 *   # (from the `workflows/` directory)
 *
 * The first smoke got a 200 but a suspiciously small body (~8 KB) and the naive
 * "looks blocked" heuristic fired. This script disambiguates, BEFORE we design
 * the Sprint 3 ML parser, between:
 *   (A) ML renders listings client-side via JS → we only got the HTML shell.
 *   (B) anti-bot soft-block → the page is a challenge/validation, not results.
 *
 * It fetches the same URL twice — ROTATING and STICKY — under ONE shared $0.50
 * guard, dumps each full body to tmp/ (gitignored) for manual inspection, and
 * prints structural signals (listing selectors, embedded-state JSON, anti-bot
 * markers, script weight). It does NOT parse listings and does NOT write to any
 * datastore. Max 2 fetches; well under the sub-limit.
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

const TARGET_URL = 'https://listado.mercadolibre.com.mx/perfume-decant'
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

const LISTING_SELECTORS = ['ui-search-result', 'ui-search-layout', 'poly-card', 'andes-money-amount', '"price"']
const STATE_MARKERS = [
  'window.__PRELOADED_STATE__',
  '__PRELOADED_STATE__',
  '__NEXT_DATA__',
  'window.__INITIAL_STATE__',
  'application/ld+json',
  'application/json',
]
const ANTIBOT_MARKERS = [
  'captcha',
  'robot',
  'Para continuar',
  'validación',
  'validacion',
  'unusual traffic',
  'cf-',
  'cloudflare',
  'Access Denied',
  'newrelic', // ML's own telemetry; presence ≈ a "real" ML page, useful as a counter-signal
]

function analyze(label: string, result: BrightDataResult): void {
  const body = result.body
  const scripts = extractScripts(body)
  const scriptBytes = scripts.reduce((a, s) => a + s.len, 0)
  const visible = visibleTextLength(body)

  console.log(`\n========== ${label} ==========`)
  console.log(`status=${result.status} attempts=${result.attempts} sessionId=${result.sessionId ?? '(rotating)'}`)
  console.log(`body: ${body.length} chars | visible text: ${visible} | <script> tags: ${scripts.length} | script bytes: ${scriptBytes} (${((scriptBytes / Math.max(1, body.length)) * 100).toFixed(0)}% of HTML)`)

  console.log('-- listing selectors (occurrences) --')
  for (const sel of LISTING_SELECTORS) console.log(`   ${sel.padEnd(20)} ${count(body, sel)}`)

  console.log('-- embedded-state markers (occurrences) --')
  for (const mk of STATE_MARKERS) console.log(`   ${mk.padEnd(28)} ${count(body, mk)}`)

  // Report the largest JSON-ish script block (NEXT_DATA / application/json / ld+json).
  const jsonish = scripts
    .filter((s) => /json/i.test(s.attrs) || /__NEXT_DATA__/i.test(s.attrs))
    .sort((a, b) => b.len - a.len)
  if (jsonish.length > 0) {
    console.log(`-- JSON-typed <script> blocks: ${jsonish.length}; largest ${jsonish[0]!.len} chars; attrs="${jsonish[0]!.attrs.slice(0, 80)}"`)
  } else {
    console.log('-- JSON-typed <script> blocks: none')
  }

  console.log('-- anti-bot / counter markers (occurrences) --')
  for (const mk of ANTIBOT_MARKERS) {
    const c = count(body, mk, true)
    if (c > 0) console.log(`   ${mk.padEnd(18)} ${c}`)
  }

  // Verdict hint (NOT a parser decision — just a signal for the human).
  const hasListings = LISTING_SELECTORS.some((s) => count(body, s) > 2)
  const hasState = jsonish.some((s) => s.len > 5000) || count(body, '__PRELOADED_STATE__') > 0
  const hint = hasState
    ? 'SIGNAL → embedded-state JSON present: likely parse JSON, no headless browser needed.'
    : hasListings
      ? 'SIGNAL → server-rendered listing markup present: DOM parse viable.'
      : 'SIGNAL → neither listings nor state JSON: likely JS-rendered shell OR soft-block (check tmp/ + anti-bot markers).'
  console.log(hint)
}

async function fetchVariant(
  brightDataFetch: ReturnType<typeof createBrightDataFetcher>,
  guard: CostGuard,
  label: string,
  sticky: boolean,
  filename: string,
): Promise<BrightDataResult | null> {
  try {
    const result = await brightDataFetch({ url: TARGET_URL, sticky, guard })
    const out = new URL(filename, TMP_DIR)
    writeFileSync(out, result.body, 'utf8')
    console.log(`[diagnose] ${label}: wrote full body → ${out.pathname}`)
    return result
  } catch (err) {
    if (err instanceof CostGuardTrippedError) {
      console.error(`[diagnose] ${label}: CostGuard tripped (${err.reason}): ${err.message}`)
    } else {
      console.error(`[diagnose] ${label}: fetch failed: ${(err as Error).message}`)
    }
    return null
  }
}

async function main(): Promise<void> {
  const envSource = loadDotEnv()
  console.log(`[diagnose] env source: ${envSource ?? '(no .env — relying on process.env)'}`)
  console.log(`[diagnose] target: ${TARGET_URL}`)
  console.log(`[diagnose] shared hard budget: $${SMOKE_BUDGET_USD.toFixed(2)}\n`)

  mkdirSync(TMP_DIR, { recursive: true })

  // One shared guard across both fetches, so the $0.50 sub-limit covers the whole diagnostic.
  const guard = new CostGuard({ maxSpendUsd: SMOKE_BUDGET_USD, costPerGbUsd: 8.0, maxConsecutiveFailures: 3 })

  const brightDataFetch = createBrightDataFetcher()

  const rotating = await fetchVariant(brightDataFetch, guard, 'ROTATING', false, 'ml-sample-rotating.html')
  const sticky = await fetchVariant(brightDataFetch, guard, 'STICKY', true, 'ml-sample-sticky.html')

  if (rotating) analyze('ROTATING', rotating)
  if (sticky) analyze('STICKY', sticky)

  if (rotating && sticky) {
    console.log('\n========== ROTATING vs STICKY ==========')
    console.log(`body chars: rotating=${rotating.body.length}  sticky=${sticky.body.length}  Δ=${sticky.body.length - rotating.body.length}`)
    const selDelta = LISTING_SELECTORS.map((s) => `${s}:${count(sticky.body, s) - count(rotating.body, s)}`).join('  ')
    console.log(`listing-selector delta (sticky - rotating): ${selDelta}`)
  }

  console.log(`\n[diagnose] guard snapshot: ${JSON.stringify(guard.snapshot())}`)
  console.log('[diagnose] inspect the dumped HTML in 02-sourcing-scout/tmp/ for the full picture.')
}

void main()
