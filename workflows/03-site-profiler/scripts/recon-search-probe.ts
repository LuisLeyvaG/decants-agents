/**
 * recon-search-probe — DISPOSABLE network reconnaissance for Agente 3 (Site
 * Profiler), NOT production code and never run by `npm test`. Run MANUALLY from
 * the `workflows/` directory:
 *
 *   node --import tsx 03-site-profiler/scripts/recon-search-probe.ts
 *   # (reads BrightData secrets from ./.env; SPENDS a tiny amount of real proxy)
 *
 * SECOND PASS (adapted): the first pass validated the search patterns but left two
 * gaps — it never captured a real PRODUCT page (the loose extractor grabbed
 * /tienda/), and ABSCENTS (Shopify) returned 402 on /search?q= without us probing
 * whether that is transient or structural. This pass:
 *   A. Re-fetches the Shopify /search?q= with 3 STICKY proxy sessions (distinct
 *      residential IPs) PLUS a 4th DIRECT fetch (no proxy, realistic Chrome UA) to
 *      disambiguate the 402 cause:
 *        - 3 sticky 402 + direct 200 → residential-IP block on Shopify /search.
 *        - all 4 402                 → request/store-level 402, not the IP.
 *        - any sticky 200            → transient; sticky/retry resolves it.
 *   B. Captures a real product page per platform (Woo + Shopify) and dumps the
 *      JSON-LD Product/Offer shape (where price/availability/name/sku live).
 *
 * PATHS: every file write uses an ABSOLUTE fs path (fileURLToPath + join). A prior
 * relative `new URL(file, dir)` pattern kept spawning a spurious nested tree.
 *
 * SAFETY: ONE shared CostGuard, hard $0.50 budget; MAX_FETCHES cap; on a budget
 * trip we STOP and report. The DIRECT fetch uses NO proxy, so it does NOT count
 * against the guard — but it DOES count against MAX_FETCHES.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as cheerio from 'cheerio'

import { prepareHtml } from '../html-prepare.js'
import { CostGuard, CostGuardTrippedError } from '../../02-sourcing-scout/scripts/cost-guard.js'
import { createBrightDataFetcher } from '../../02-sourcing-scout/scripts/brightdata-fetch.js'

// ---------------------------------------------------------------------------
// Absolute paths (NO relative URL resolution at write time)
// ---------------------------------------------------------------------------

const ENV_PATH = fileURLToPath(new URL('../../.env', import.meta.url)) // workflows/.env
const OUT_DIR = fileURLToPath(new URL('../tmp/recon/', import.meta.url)) // 03-site-profiler/tmp/recon/

function saveHtml(file: string, body: string): string {
  const abs = join(OUT_DIR, file) // file is always a bare basename
  writeFileSync(abs, body, 'utf8')
  return file
}

// ---------------------------------------------------------------------------
// Minimal .env loader (disposable, no dotenv dep)
// ---------------------------------------------------------------------------

function loadDotEnv(): string | null {
  let raw: string
  try {
    raw = readFileSync(ENV_PATH, 'utf8')
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
  return ENV_PATH
}

// ---------------------------------------------------------------------------
// Config — this focused second pass
// ---------------------------------------------------------------------------

const ABSCENTS_SEARCH_URL = 'https://abscents.com.mx/search?q=Valentino'
// Session ids MUST be alphanumeric: a hyphen breaks Bright Data's username parsing
// after `-session-` → proxy 407. (defaultSessionId uses hex for the same reason.)
const STICKY_SESSIONS: readonly string[] = ['recona1', 'recona2', 'recona3']

/** Real Woo product detail (English /product/ slug) extracted from the on-disk fixture. */
const WOO_PRODUCT_URL = 'https://decantados.com/product/coleccion-imperial/'
/** Fallback Shopify product (single perfume handle from the on-disk homepage fixture). */
const SHOPIFY_PRODUCT_FALLBACK = 'https://abscents.com.mx/products/acqua-di-gio-profondo'

const BUDGET_USD = 0.5
const MAX_FETCHES = 9 // ~5 proxy + the 4th direct + margin

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** Shopify product-detail links. */
const SHOPIFY_PRODUCT_RE = /\/products\/[A-Za-z0-9._-]+/
/** ABSCENTS homepage title prefix — to tell a real search page from a param-ignored homepage. */
const ABSCENTS_HOME_TITLE_PREFIX = 'ABSCENTS'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const titleOf = (html: string): string => (html.match(/<title[^>]*>([^<]*)/i)?.[1] ?? '').trim()

/** Does the HTML look like a real Shopify SEARCH-RESULTS surface (not the param-ignored homepage)? */
function looksLikeSearchSurface(html: string, title: string): boolean {
  if (title && !title.startsWith(ABSCENTS_HOME_TITLE_PREFIX)) return true
  return /template--search|id="ProductGridContainer"|resultados de (la )?b[uú]squeda|search-results/i.test(html)
}

/** First href matching `re`, resolved absolute against `baseUrl`; null if none. */
function firstLink(html: string, baseUrl: string, re: RegExp): string | null {
  const $ = cheerio.load(html)
  let found: string | null = null
  $('a[href]').each((_, el) => {
    if (found) return
    const href = $(el).attr('href')
    if (href && re.test(href)) {
      try {
        found = new URL(href, baseUrl).toString()
      } catch {
        /* skip */
      }
    }
  })
  return found
}

/** DIRECT egress fetch (this machine's IP), no proxy, realistic Chrome UA. */
async function directFetchWithUa(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    headers: {
      'user-agent': CHROME_UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'es-MX,es;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  })
  const body = await res.text()
  return { status: res.status, body }
}

// --- JSON-LD Product/Offer preview ----------------------------------------

type Obj = Record<string, unknown>

const typesOf = (o: Obj): string[] => {
  const t = o['@type']
  return (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === 'string')
}

/** Flatten every object node in the JSON-LD (descending @graph). */
function flattenNodes(jsonLd: readonly unknown[]): Obj[] {
  const out: Obj[] = []
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') {
      const o = v as Obj
      out.push(o)
      if (Array.isArray(o['@graph'])) (o['@graph'] as unknown[]).forEach(walk)
    }
  }
  jsonLd.forEach(walk)
  return out
}

function previewJsonLd(label: string, jsonLd: readonly unknown[]): void {
  const nodes = flattenNodes(jsonLd)
  const product = nodes.find((o) => typesOf(o).some((t) => t.includes('Product'))) ?? null
  const allTypes = [...new Set(nodes.flatMap(typesOf))]
  console.log(`    [${label}] JSON-LD @types present: ${allTypes.join(', ') || '(none)'}`)
  if (!product) {
    console.log(`    [${label}] no Product node found.`)
    return
  }
  console.log(`    [${label}] Product keys: ${Object.keys(product).join(', ')}`)
  console.log(`      name:  ${JSON.stringify(product['name'])}`)
  console.log(`      sku:   ${JSON.stringify(product['sku'])}`)
  console.log(`      brand: ${JSON.stringify(product['brand'])}`)
  const offers = product['offers']
  const offerArr = Array.isArray(offers) ? offers : offers ? [offers] : []
  if (offerArr.length === 0) {
    console.log(`      offers: (none on Product node)`)
    return
  }
  offerArr.slice(0, 3).forEach((of, i) => {
    const o = (of ?? {}) as Obj
    console.log(
      `      offers[${i}]: keys=${Object.keys(o).join(',')} | ` +
        `price=${JSON.stringify(o['price'])} priceCurrency=${JSON.stringify(o['priceCurrency'])} ` +
        `availability=${JSON.stringify(o['availability'])} sku=${JSON.stringify(o['sku'])}`,
    )
  })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const envSource = loadDotEnv()
  mkdirSync(OUT_DIR, { recursive: true })
  console.log(`[recon-2] env source: ${envSource ?? '(no .env)'}`)
  console.log(`[recon-2] budget $${BUDGET_USD.toFixed(2)} | max fetches ${MAX_FETCHES} | out ${OUT_DIR}\n`)

  const guard = new CostGuard({ maxSpendUsd: BUDGET_USD, costPerGbUsd: 8.0, maxConsecutiveFailures: MAX_FETCHES + 1 })
  const brightDataFetch = createBrightDataFetcher()
  let fetches = 0
  const newFiles: string[] = []

  try {
    // ---- OBJECTIVE A: the 402 — 3 sticky (proxy) + 1 direct (no proxy) ----
    console.log('========== OBJECTIVE A — Shopify /search?q= : 3 sticky proxy + 1 direct(UA) ==========')
    const stickyStatuses: Array<number | 'ERR'> = []
    let shopifyProductFromSearch: string | null = null

    for (let i = 0; i < STICKY_SESSIONS.length && fetches < MAX_FETCHES; i++) {
      const sessionId = STICKY_SESSIONS[i] as string
      fetches += 1
      let res
      try {
        res = await brightDataFetch({ url: ABSCENTS_SEARCH_URL, guard, sticky: true, sessionId, maxRetries: 1 })
      } catch (e) {
        if (e instanceof CostGuardTrippedError) throw e
        stickyStatuses.push('ERR')
        console.error(`  [proxy sticky=${sessionId}] ERROR: ${(e as Error).message}`)
        continue
      }
      const file = saveHtml(`abscents-search-sticky-${i + 1}.html`, res.body)
      newFiles.push(file)
      stickyStatuses.push(res.status)
      const title = titleOf(res.body)
      const isSearch = res.status === 200 && looksLikeSearchSurface(res.body, title)
      console.log(
        `  [proxy sticky=${sessionId}] -> ${res.status}  loc=${res.location ?? '-'}  bytes=${res.bytesTransferred}  ` +
          `title="${title.slice(0, 55)}"  ${res.status === 200 ? (isSearch ? 'REAL-SEARCH' : 'homepage(param-ignored)') : ''}  [${file}]`,
      )
      if (isSearch && !shopifyProductFromSearch) shopifyProductFromSearch = firstLink(res.body, ABSCENTS_SEARCH_URL, SHOPIFY_PRODUCT_RE)
    }

    // 4th DISAMBIGUATOR: direct (no proxy), Chrome UA. Counts in MAX_FETCHES, NOT in the guard.
    let directStatus: number | null = null
    if (fetches < MAX_FETCHES) {
      fetches += 1
      try {
        const d = await directFetchWithUa(ABSCENTS_SEARCH_URL)
        directStatus = d.status
        const file = saveHtml('abscents-search-direct-ua.html', d.body)
        newFiles.push(file)
        const title = titleOf(d.body)
        const isSearch = d.status === 200 && looksLikeSearchSurface(d.body, title)
        console.log(
          `  [DIRECT no-proxy UA] -> ${d.status}  title="${title.slice(0, 55)}"  ` +
            `${d.status === 200 ? (isSearch ? 'REAL-SEARCH' : 'homepage(param-ignored)') : ''}  [${file}]`,
        )
        if (isSearch && !shopifyProductFromSearch) shopifyProductFromSearch = firstLink(d.body, ABSCENTS_SEARCH_URL, SHOPIFY_PRODUCT_RE)
      } catch (e) {
        console.error(`  [DIRECT no-proxy UA] FAILED: ${(e as Error).message}`)
      }
    }

    const allSticky402 = stickyStatuses.length > 0 && stickyStatuses.every((s) => s === 402)
    const anySticky200 = stickyStatuses.some((s) => s === 200)
    let verdict: string
    if (anySticky200) verdict = 'TRANSIENT — a sticky proxy IP reached 200 (sticky/retry resolves it)'
    else if (allSticky402 && directStatus === 200) verdict = 'RESIDENTIAL-IP BLOCK — proxy 402 on /search, direct(UA) 200 (Shopify blocks residential IPs on that surface)'
    else if (allSticky402 && directStatus === 402) verdict = 'REQUEST/STORE-LEVEL 402 — not the IP (all four 402)'
    else verdict = 'MIXED / inconclusive — see statuses'
    console.log(`  => STATUSES: sticky=[${stickyStatuses.join(',')}]  direct=${directStatus ?? 'n/a'}`)
    console.log(`  => VERDICT: ${verdict}`)

    // ---- OBJECTIVE B: real product pages + JSON-LD -----------------------
    console.log('\n========== OBJECTIVE B — real product pages + JSON-LD (via proxy) ==========')
    const targets: Array<{ label: string; url: string; file: string }> = [
      { label: 'Decantados/Woo', url: WOO_PRODUCT_URL, file: 'decantados-product-real.html' },
      { label: 'ABSCENTS/Shopify', url: shopifyProductFromSearch ?? SHOPIFY_PRODUCT_FALLBACK, file: 'abscents-product-real.html' },
    ]
    console.log(
      shopifyProductFromSearch
        ? `  (Shopify product via SEARCH result: ${shopifyProductFromSearch})`
        : `  (Shopify product via FALLBACK: ${SHOPIFY_PRODUCT_FALLBACK} — no navigable search results)`,
    )

    for (const t of targets) {
      if (fetches >= MAX_FETCHES) {
        console.warn(`  MAX_FETCHES reached — skipping ${t.label}`)
        break
      }
      fetches += 1
      let res
      try {
        res = await brightDataFetch({ url: t.url, guard, maxRetries: 1 })
      } catch (e) {
        if (e instanceof CostGuardTrippedError) throw e
        console.error(`  ${t.label} ERROR: ${(e as Error).message}`)
        continue
      }
      const file = saveHtml(t.file, res.body)
      newFiles.push(file)
      const prepared = prepareHtml(res.body)
      console.log(
        `\n  ${t.label}  ${res.status}  ${t.url}\n` +
          `    bytes=${res.bytesTransferred}  title="${titleOf(res.body).slice(0, 55)}"  ` +
          `hadJsonLd=${prepared.signals.hadJsonLd}  jsonLdHadProduct=${prepared.signals.jsonLdHadProduct}  ` +
          `prunedBytes=${prepared.signals.prunedBytes}  [${file}]`,
      )
      previewJsonLd(t.label, prepared.jsonLd)
    }
  } catch (err) {
    if (err instanceof CostGuardTrippedError) {
      console.error(`\n[recon-2] CostGuard tripped (${err.reason}): ${err.message} — STOPPING.`)
      console.error(`[recon-2] guard snapshot: ${JSON.stringify(guard.snapshot())}`)
    } else {
      console.error(`\n[recon-2] fetch failed (password-redacted): ${(err as Error).message}`)
    }
    process.exitCode = 1
  }

  const snap = guard.snapshot()
  console.log(`\n========== SUMMARY ==========`)
  console.log(
    `fetches: ${fetches} (incl. 1 direct/no-proxy) | proxy USD spent: $${snap.spentUsd.toFixed(6)} | ` +
      `proxy bytes: ${snap.bytesTransferred} | tripped: ${snap.tripped}`,
  )
  console.log(`new files in tmp/recon/: ${newFiles.join(', ')}`)
}

void main()
