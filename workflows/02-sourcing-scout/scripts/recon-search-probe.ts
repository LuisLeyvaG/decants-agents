/**
 * recon-search-probe — DISPOSABLE network reconnaissance for Agente 3 (Site
 * Profiler), NOT production code and never run by `npm test`. Sibling in spirit
 * to smoke-brightdata.ts. Run it MANUALLY from the `workflows/` directory:
 *
 *   node --import tsx 02-sourcing-scout/scripts/recon-search-probe.ts
 *   # (reads BrightData secrets from ./.env; SPENDS a tiny amount of real proxy)
 *
 * GOAL: capture REAL search + product HTML from 1-2 active providers so we design
 * the real search-probe module (3b-0b) against data, not assumptions — and harvest
 * real fixtures for the 3b-0b/3c tests. It writes raw HTML to tmp/recon/ and prints
 * a results table; it touches NO database and never prints the proxy password.
 *
 * SAFETY:
 *   - ONE shared CostGuard with a hard $0.50 budget (NOT the $2 v1 budget). On a
 *     budget trip we STOP and report — never swallow CostGuardTrippedError.
 *   - A hard MAX_FETCHES cap so a redirect/pagination loop cannot burn budget.
 *   - maxConsecutiveFailures is set HIGH on purpose: in DIAGNOSTIC mode we WANT to
 *     probe every pattern even when several 404/403, to fill the table. The
 *     failure breaker is a production safety valve, not wanted here; budget +
 *     MAX_FETCHES are the real stops.
 *   - brightDataFetch still does NOT follow redirects; on a 3xx we report
 *     `location` and move on (the production module will follow it).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import * as cheerio from 'cheerio'

import { prepareHtml } from '../../03-site-profiler/html-prepare.js'
import { CostGuard, CostGuardTrippedError } from './cost-guard.js'
import { createBrightDataFetcher } from './brightdata-fetch.js'

// ---------------------------------------------------------------------------
// Minimal .env loader (copied from smoke-brightdata.ts — disposable, no dotenv dep)
// ---------------------------------------------------------------------------

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
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
  return candidate.pathname
}

// ---------------------------------------------------------------------------
// Recon config — all local consts (brands are HARDCODED here, NOT read from A1)
// ---------------------------------------------------------------------------

interface ProbeProvider {
  readonly name: string
  readonly catalogUrl: string
}

/** The 1-2 real active providers chosen from agent.providers (status='active'). */
const PROVIDERS: readonly ProbeProvider[] = [
  { name: 'ABSCENTS', catalogUrl: 'https://abscents.com.mx/' },
  { name: 'Olfactum', catalogUrl: 'https://olfactum.mx/collections/all' },
]

/** Search-pattern hypotheses, probed IN THIS ORDER (the design decision for A3). */
const PATTERNS: readonly string[] = ['/search?q=', '?s=', '?q=', '/buscar?q=']

/** Hardcoded test brands — const hypothesis, retried in order on an empty search. */
const PROBE_BRANDS: readonly string[] = ['Valentino', 'Jean Paul Gaultier', 'Dior']

const BUDGET_USD = 0.5 // hard sub-limit for the experiment, NOT the $2 v1 budget
const MAX_FETCHES = 16 // hard cap on total proxy calls, independent of the budget

/** Loose "this looks like a product link" heuristic for counting + first-link extraction. */
const PRODUCT_HREF_RE = /\/(producto|productos|product|products|p|item|items|shop|tienda)\//i

/** Loose "no results" copy, ES + EN. */
const EMPTY_TEXT_RE =
  /(no se encontr|sin resultados|no hay (productos|resultados)|0 resultados|no results|nothing found)/i

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

const OUT_DIR = new URL('../tmp/recon/', import.meta.url)

function saveHtml(file: string, body: string): string {
  const target = new URL(file, OUT_DIR)
  writeFileSync(target, body, 'utf8')
  return target.pathname
}

interface SearchAnalysis {
  readonly productHrefCount: number
  readonly totalAnchors: number
  readonly emptyText: boolean
  readonly firstProductUrl: string | null
  readonly looksBlocked: boolean
}

/** Loose, NON-authoritative analysis of a search-results HTML body. */
function analyzeSearchHtml(body: string, baseUrl: string): SearchAnalysis {
  const $ = cheerio.load(body)
  let productHrefCount = 0
  let firstProductUrl: string | null = null
  const anchors = $('a[href]')
  anchors.each((_, el) => {
    const href = $(el).attr('href')
    if (!href) return
    if (PRODUCT_HREF_RE.test(href)) {
      productHrefCount += 1
      if (firstProductUrl === null) {
        try {
          firstProductUrl = new URL(href, baseUrl).toString()
        } catch {
          /* skip un-resolvable href */
        }
      }
    }
  })
  const lower = body.toLowerCase()
  return {
    productHrefCount,
    totalAnchors: anchors.length,
    emptyText: EMPTY_TEXT_RE.test(body),
    firstProductUrl,
    looksBlocked: lower.includes('captcha') || lower.includes('are you a robot'),
  }
}

type Verdict = 'results' | 'empty' | 'redirect' | 'blocked' | `http_${number}`

function verdictFor(status: number, a: SearchAnalysis): Verdict {
  if (status >= 300 && status < 400) return 'redirect'
  if (a.looksBlocked || status === 403) return 'blocked'
  if (status < 200 || status >= 400) return `http_${status}`
  if (a.productHrefCount >= 3) return 'results'
  if (a.emptyText) return 'empty'
  return a.productHrefCount > 0 ? 'results' : 'empty'
}

interface TableRow {
  readonly provider: string
  readonly pattern: string
  readonly brand: string
  readonly status: number
  readonly location: string | null
  readonly bytes: number
  readonly productHrefs: number
  readonly verdict: Verdict
  readonly savedFile: string
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const envSource = loadDotEnv()
  mkdirSync(OUT_DIR, { recursive: true })

  console.log(`[recon] env source:    ${envSource ?? '(no .env — relying on process.env)'}`)
  console.log(`[recon] providers:     ${PROVIDERS.map((p) => p.name).join(', ')}`)
  console.log(`[recon] patterns:      ${PATTERNS.join('  ')}`)
  console.log(`[recon] brands:        ${PROBE_BRANDS.join(', ')}`)
  console.log(`[recon] hard budget:   $${BUDGET_USD.toFixed(2)}  |  max fetches: ${MAX_FETCHES}`)
  console.log(`[recon] out dir:       ${OUT_DIR.pathname}\n`)

  // Diagnostic guard: real budget cap, but failure-breaker effectively disabled
  // (we WANT to probe failing patterns) — see the docblock.
  const guard = new CostGuard({
    maxSpendUsd: BUDGET_USD,
    costPerGbUsd: 8.0,
    maxConsecutiveFailures: MAX_FETCHES + 1,
  })
  const brightDataFetch = createBrightDataFetcher()

  const rows: TableRow[] = []
  const productNotes: string[] = []
  let fetches = 0

  const capReached = (): boolean => {
    if (fetches >= MAX_FETCHES) {
      console.warn(`\n[recon] MAX_FETCHES (${MAX_FETCHES}) reached — stopping early to protect budget.`)
      return true
    }
    return false
  }

  try {
    for (const provider of PROVIDERS) {
      const origin = new URL(provider.catalogUrl).origin
      console.log(`\n========== ${provider.name}  (${origin}) ==========`)
      let winner: { pattern: string; firstProductUrl: string } | null = null

      for (const pattern of PATTERNS) {
        if (capReached()) break

        // Try brands in order; stop at the first that yields a clear 'results'.
        let chosen: { brand: string; status: number; location: string | null; bytes: number; a: SearchAnalysis } | null = null
        for (const brand of PROBE_BRANDS) {
          if (capReached()) break
          const searchUrl = `${origin}${pattern}${encodeURIComponent(brand)}`
          fetches += 1
          const res = await brightDataFetch({ url: searchUrl, guard, maxRetries: 1 })
          const a = analyzeSearchHtml(res.body, searchUrl)
          const file = saveHtml(`${slug(provider.name)}-${slug(pattern)}-${slug(brand)}.html`, res.body)
          chosen = { brand, status: res.status, location: res.location, bytes: res.bytesTransferred, a }
          const v = verdictFor(res.status, a)
          rows.push({
            provider: provider.name,
            pattern,
            brand,
            status: res.status,
            location: res.location,
            bytes: res.bytesTransferred,
            productHrefs: a.productHrefCount,
            verdict: v,
            savedFile: file,
          })
          console.log(
            `  ${pattern.padEnd(12)} q=${brand.padEnd(20)} -> ${res.status}  ` +
              `loc=${res.location ?? '-'}  bytes=${res.bytes ?? res.bytesTransferred}  ` +
              `prodHrefs=${a.productHrefCount}  verdict=${v}  [${file.split('/').pop()}]`,
          )
          // A clear win, or a definitive non-2xx/redirect (no point retrying brands): stop.
          if (v === 'results' || v === 'redirect' || v === 'blocked' || v.startsWith('http_')) break
        }

        if (chosen && verdictFor(chosen.status, chosen.a) === 'results' && chosen.a.firstProductUrl && !winner) {
          winner = { pattern, firstProductUrl: chosen.a.firstProductUrl }
        }
      }

      // Fetch #2: the product page for the FIRST winning pattern only.
      if (winner && !capReached()) {
        console.log(`  -> winning pattern: ${winner.pattern}  first product: ${winner.firstProductUrl}`)
        fetches += 1
        const prod = await brightDataFetch({ url: winner.firstProductUrl, guard, maxRetries: 1 })
        const file = saveHtml(`${slug(provider.name)}-product.html`, prod.body)
        const prepared = prepareHtml(prod.body)
        const note =
          `  PRODUCT ${prod.status}  bytes=${prod.bytesTransferred}  ` +
          `hadJsonLd=${prepared.signals.hadJsonLd}  jsonLdHadProduct=${prepared.signals.jsonLdHadProduct}  ` +
          `[${file.split('/').pop()}]`
        console.log(note)
        productNotes.push(`${provider.name}:${note.trim()}`)
      } else if (!winner) {
        console.log(`  -> NO winning pattern for ${provider.name} (would be recipe_status='failed' / no_search_pattern)`)
        productNotes.push(`${provider.name}: no_search_pattern`)
      }
    }
  } catch (err) {
    if (err instanceof CostGuardTrippedError) {
      console.error(`\n[recon] CostGuard tripped (${err.reason}): ${err.message} — STOPPING.`)
      console.error(`[recon] guard snapshot: ${JSON.stringify(guard.snapshot())}`)
    } else {
      console.error(`\n[recon] fetch failed (password-redacted): ${(err as Error).message}`)
    }
    process.exitCode = 1
  }

  // Summary
  const snap = guard.snapshot()
  console.log(`\n========== SUMMARY ==========`)
  console.log(`total fetches: ${fetches}  |  USD spent: $${snap.spentUsd.toFixed(6)}  |  bytes: ${snap.bytesTransferred}`)
  console.log(`\nprovider | pattern | brand | status | location | prodHrefs | verdict`)
  for (const r of rows) {
    console.log(
      `${r.provider} | ${r.pattern} | ${r.brand} | ${r.status} | ${r.location ?? '-'} | ${r.productHrefs} | ${r.verdict}`,
    )
  }
  console.log(`\nproduct pages:`)
  for (const n of productNotes) console.log(`  ${n}`)
}

void main()
