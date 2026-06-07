/**
 * html-prepare — deterministic, network-free pre-processor that turns a raw
 * storefront HTML string into the trimmed input the Site Profiler LLM will see
 * (wired in 3b-ii). Pure: no fetch, no LLM, no DB. Unit-testable with fixtures.
 *
 * It produces THREE things the model needs to write a SiteRecipe
 * (schemas/site-recipe.schema.ts), one per extraction strategy:
 *   - jsonLd     → the PRIMARY signal for strategy 'json-ld'. Extracted INTACT
 *                  (before any pruning) and never truncated.
 *   - prunedHtml → the de-noised DOM the model reads to write 'css' / 'xpath'
 *                  selectors when JSON-LD is absent or incomplete. The JSON-LD is
 *                  deliberately NOT duplicated here: it already lives whole in
 *                  `jsonLd`, and leaving it inline would make the model pay for
 *                  those tokens twice.
 *   - signals    → reporting only. html-prepare REPORTS, it does not JUDGE: it
 *                  never decides whether a recipe fails (that is validateAndProfile).
 *
 * Parser: cheerio (parse5-grade) — real storefront HTML is malformed; a regex
 * prune would corrupt the very structure the model turns into selectors.
 */

import * as cheerio from 'cheerio'
import type { CheerioAPI } from 'cheerio'

/**
 * Byte cap on `prunedHtml`. CALIBRATION HYPOTHESIS — initial value, to recalibrate
 * with real fetched pages in 3c (same spirit as A2's thresholds living in code).
 *
 * 200 KB of HTML ≈ 50–60k input tokens (HTML is tag-dense, ~3–4 chars/token).
 * That keeps virtually every real *pruned* product page whole while bounding
 * pathological infinite-scroll catalogs, and leaves ample context for the
 * reasoning model's reserved reasoning+output budget — the reservation that bit
 * A2 (over-reserving max_output_tokens starved the request). The <head>
 * (JSON-LD + <meta>) is ALWAYS preserved; only the <body> is trimmed to fit.
 */
export const MAX_PRUNED_HTML_BYTES = 200_000

export interface PrepareHtmlOptions {
  /** Override the prunedHtml byte cap (tests use a small value to force truncation). */
  readonly maxPrunedBytes?: number
}

export interface PreparedHtmlSignals {
  readonly hadJsonLd: boolean
  readonly jsonLdHadProduct: boolean
  readonly originalBytes: number
  readonly prunedBytes: number
  readonly truncated: boolean
}

export interface PreparedHtml {
  /** Parsed JSON-LD blocks (valid JSON only), in document order. Never truncated. */
  readonly jsonLd: ReadonlyArray<unknown>
  /** The de-noised DOM as an HTML string (head intact; body trimmed if over cap). */
  readonly prunedHtml: string
  readonly signals: PreparedHtmlSignals
}

const LD_JSON_SELECTOR = 'script[type="application/ld+json"]'

/** Does a parsed JSON-LD value contain a Product/Offer @type anywhere (incl. @graph)? */
function hasProductOrOffer(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasProductOrOffer)
  if (node !== null && typeof node === 'object') {
    const obj = node as Record<string, unknown>
    const t = obj['@type']
    const types = Array.isArray(t) ? t : [t]
    if (types.some((x) => typeof x === 'string' && (x.includes('Product') || x.includes('Offer')))) {
      return true
    }
    return Object.values(obj).some(hasProductOrOffer)
  }
  return false
}

/** Truncate a string to at most `maxBytes` UTF-8 bytes without splitting a codepoint. */
function sliceUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= maxBytes) return s
  let end = maxBytes
  // Back off out of a multibyte continuation byte (0b10xxxxxx).
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--
  return buf.subarray(0, end).toString('utf8')
}

/** Trim back to the last closed tag so we never emit a half-written element. */
function backOffToClosedTag(s: string): string {
  const i = s.lastIndexOf('>')
  return i >= 0 ? s.slice(0, i + 1) : s
}

/** Reserialize keeping <head> whole and trimming <body> inner to fit `cap` bytes. */
function truncateKeepingHead($: CheerioAPI, cap: number): string {
  const headOuter = $.html($('head'))
  const bodyInner = $('body').html() ?? ''
  const shellBytes = Buffer.byteLength(`<html>${headOuter}<body></body></html>`, 'utf8')
  const budget = cap - shellBytes
  const body = budget > 0 ? backOffToClosedTag(sliceUtf8(bodyInner, budget)) : ''
  return `<html>${headOuter}<body>${body}</body></html>`
}

export function prepareHtml(
  rawHtml: string,
  opts: PrepareHtmlOptions = {},
): PreparedHtml {
  const cap = opts.maxPrunedBytes ?? MAX_PRUNED_HTML_BYTES
  const originalBytes = Buffer.byteLength(rawHtml, 'utf8')

  const $ = cheerio.load(rawHtml)

  // --- 1. Extract JSON-LD (the primary signal) BEFORE pruning. -------------
  const jsonLd: unknown[] = []
  let hadJsonLd = false
  $(LD_JSON_SELECTOR).each((_, el) => {
    hadJsonLd = true
    try {
      jsonLd.push(JSON.parse($(el).text()))
    } catch {
      // Malformed JSON-LD: reported via hadJsonLd, but not emitted as data.
    }
  })
  const jsonLdHadProduct = jsonLd.some(hasProductOrOffer)

  // --- 2. Prune the DOM. ----------------------------------------------------
  // Drop EVERY <script>, including the ld+json blocks: they were already
  // extracted above and live only in `jsonLd`, so keeping them inline would
  // bill the model for the same tokens twice.
  $('script').remove()
  $('style, svg').remove()
  // HTML comments, at any depth and at the root.
  $('*').contents().each((_, el) => {
    if (el.type === 'comment') $(el).remove()
  })
  $.root().contents().each((_, el) => {
    if (el.type === 'comment') $(el).remove()
  })
  // Pure-style attributes: style= and on*= event handlers. Everything else
  // (class, id, data-*, itemprop, role, href, src, content, …) is kept.
  $('*').each((_, el) => {
    if (!('attribs' in el)) return
    for (const name of Object.keys(el.attribs)) {
      if (name === 'style' || /^on/i.test(name)) $(el).removeAttr(name)
    }
  })

  // --- 3. Serialize, truncating the body only if over the cap. --------------
  const fullPruned = $.html()
  let prunedHtml = fullPruned
  let truncated = false
  if (Buffer.byteLength(fullPruned, 'utf8') > cap) {
    truncated = true
    prunedHtml = truncateKeepingHead($, cap)
  }

  return {
    jsonLd,
    prunedHtml,
    signals: {
      hadJsonLd,
      jsonLdHadProduct,
      originalBytes,
      prunedBytes: Buffer.byteLength(prunedHtml, 'utf8'),
      truncated,
    },
  }
}
