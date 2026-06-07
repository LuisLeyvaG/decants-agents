/**
 * Unit tests for prepareHtml (A3 — Site Profiler HTML pre-processor).
 *
 * Pure: from a raw HTML string → { jsonLd, prunedHtml, signals }. No network, no
 * LLM, no DB. Fixtures are real files under __tests__/fixtures/ (synthetic, so
 * they can be reused in 3c without spending proxy quota).
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MAX_PRUNED_HTML_BYTES, prepareHtml } from '../html-prepare.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = (name: string): string =>
  readFileSync(resolve(__dirname, 'fixtures', name), 'utf8')

describe('prepareHtml — JSON-LD (primary signal)', () => {
  it('(a) extracts a Product JSON-LD block and flags jsonLdHadProduct', () => {
    const r = prepareHtml(fixture('shopify-with-jsonld.html'))
    expect(r.signals.hadJsonLd).toBe(true)
    expect(r.signals.jsonLdHadProduct).toBe(true)
    expect(r.jsonLd).toHaveLength(1)
    expect(JSON.stringify(r.jsonLd)).toContain('"@type":"Offer"')
  })

  it('(b) a page without JSON-LD yields empty jsonLd but keeps structure', () => {
    const r = prepareHtml(fixture('plain-no-jsonld.html'))
    expect(r.signals.hadJsonLd).toBe(false)
    expect(r.signals.jsonLdHadProduct).toBe(false)
    expect(r.jsonLd).toEqual([])
    expect(r.prunedHtml).toContain('itemprop="name"')
    expect(r.prunedHtml).toContain('data-price="780"')
    expect(r.prunedHtml).toContain('class="availability"')
  })

  it('malformed JSON-LD is reported (hadJsonLd) but not emitted, and never throws', () => {
    const r = prepareHtml(
      '<html><head><script type="application/ld+json">{bad,]</script></head><body></body></html>',
    )
    expect(r.signals.hadJsonLd).toBe(true)
    expect(r.jsonLd).toEqual([])
  })
})

describe('prepareHtml — pruning', () => {
  it('(d) removes ALL scripts (incl. ld+json), styles, svg and handlers; structure kept', () => {
    const r = prepareHtml(fixture('shopify-with-jsonld.html'))
    // ld+json is extracted to the jsonLd field, NOT duplicated in the DOM.
    expect(r.jsonLd).toHaveLength(1)
    expect(r.prunedHtml).not.toContain('application/ld+json')
    // other noise gone
    expect(r.prunedHtml).not.toContain('<style')
    expect(r.prunedHtml).not.toContain('<svg')
    expect(r.prunedHtml).not.toContain('gtag(') // analytics script gone
    expect(r.prunedHtml).not.toContain('/cdn/app.js') // body script gone
    expect(r.prunedHtml).not.toContain('onclick')
    expect(r.prunedHtml).not.toContain('style=')
    expect(r.prunedHtml).not.toContain('<!--') // comment gone
    // structure kept
    expect(r.prunedHtml).toContain('itemprop="price"')
    expect(r.prunedHtml).toContain('data-availability="in_stock"')
    expect(r.prunedHtml).toContain('class="product-title"')
  })
})

describe('prepareHtml — size cap', () => {
  it('(c) truncates the body over the cap while keeping <head> intact', () => {
    const r = prepareHtml(fixture('large-catalog.html'), { maxPrunedBytes: 1500 })
    expect(r.signals.truncated).toBe(true)
    expect(r.prunedHtml).toContain('<head>')
    expect(r.prunedHtml).toContain('name="title"') // head meta preserved
    expect(r.prunedHtml).toContain('data-id="1"') // head of body kept
    expect(r.prunedHtml).not.toContain('data-id="15"') // tail of body dropped
    expect(r.signals.prunedBytes).toBeLessThan(r.signals.originalBytes)
  })

  it('a normal page under the default cap is not truncated', () => {
    const r = prepareHtml(fixture('shopify-with-jsonld.html'))
    expect(r.signals.truncated).toBe(false)
    expect(MAX_PRUNED_HTML_BYTES).toBe(200_000)
  })
})

describe('prepareHtml — determinism', () => {
  it('(e) same input yields byte-identical output', () => {
    const html = fixture('shopify-with-jsonld.html')
    expect(JSON.stringify(prepareHtml(html))).toBe(JSON.stringify(prepareHtml(html)))
  })
})
