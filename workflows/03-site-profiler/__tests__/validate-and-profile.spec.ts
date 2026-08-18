/**
 * Unit tests for validateAndProfile (A3 — Site Profiler).
 *
 * Pure: from a SiteRecipe (already Zod-validated upstream) → resolved
 * recipe_status + per-slot rule failures + the model's 'failed' floor. No
 * Postgres, no OpenAI, no Bright Data. Mirrors
 * 02-sourcing-scout/__tests__/validate-and-filter.spec.ts.
 *
 * Three cross-field rules under test (the ones SiteRecipeSchema documents but
 * does not enforce):
 *   1. validity — active ⇔ title + variants{container,price,availability} usable;
 *   2. attribute_name required when source='attribute' (all nine slots);
 *   3. price_high only under aggregate-range (per-offer with non-null price_high
 *      → failed; the inverse is NOT enforced).
 * Rule 1 is also structurally guaranteed by Zod, so the "missing mandatory"
 * cases feed deliberately-degenerate shapes via deletion, exactly as A2's spec
 * deletes required fields before re-parsing.
 *
 * STATUS is re-derived WITH A FLOOR: 'failed' if a rule fails OR the model
 * emitted recipe_status='failed'. The code degrades active→failed but never
 * promotes failed→active.
 */

import {
  MANDATORY_FIELDS,
  validateAndProfile,
  type SelectorPath,
} from '../validate-and-profile.js'
import type { FieldSelector, SiteRecipe } from '../schemas/site-recipe.schema.js'

const makeFieldSelector = (o: Partial<FieldSelector> = {}): FieldSelector => ({
  strategy: 'json-ld',
  selector: 'offers.price',
  source: 'json',
  attribute_name: null,
  cleanup_regex: null,
  extraction_confidence: 'high',
  ...o,
})

const makeVariants = (
  o: Partial<SiteRecipe['selectors']['variants']> = {},
): SiteRecipe['selectors']['variants'] => ({
  mode: 'per-offer',
  container: makeFieldSelector({ selector: 'offers', source: 'json' }),
  ml: null,
  price: makeFieldSelector({ selector: 'price', source: 'json' }),
  price_high: null,
  availability: makeFieldSelector({
    selector: 'availability',
    source: 'json',
    cleanup_regex: 'https?://schema\\.org/(InStock|OutOfStock)',
  }),
  ...o,
})

const makeRecipe = (o: Partial<SiteRecipe> = {}): SiteRecipe => ({
  search_url_template: '?s=<query>',
  selectors: {
    title: makeFieldSelector({ selector: 'name', source: 'json' }),
    brand: null,
    sku: null,
    currency: null,
    variants: makeVariants(),
  },
  recipe_status: 'active',
  ...o,
})

/** A complete aggregate-range (Woo) recipe: lowPrice + highPrice both present. */
const makeAggregateRecipe = (o: Partial<SiteRecipe> = {}): SiteRecipe =>
  makeRecipe({
    selectors: {
      title: makeFieldSelector({ selector: 'name', source: 'json' }),
      brand: null,
      sku: makeFieldSelector({ selector: 'sku', source: 'json' }),
      currency: makeFieldSelector({ selector: 'offers.0.priceCurrency', source: 'json' }),
      variants: makeVariants({
        mode: 'aggregate-range',
        container: makeFieldSelector({ selector: 'offers.0', source: 'json' }),
        price: makeFieldSelector({ selector: 'lowPrice', source: 'json' }),
        price_high: makeFieldSelector({ selector: 'highPrice', source: 'json' }),
      }),
    },
    ...o,
  })

/** Build a recipe whose `selectors` is overridden wholesale (allows degenerate shapes). */
const recipeWithSelectors = (
  selectors: unknown,
  overrides: Partial<SiteRecipe> = {},
): SiteRecipe => ({ ...makeRecipe(overrides), selectors } as SiteRecipe)

/** Build a recipe with one mandatory slot DELETED (by its dotted path). */
const recipeMissing = (path: SelectorPath): SiteRecipe => {
  const r = makeRecipe()
  if (path.startsWith('variants.')) {
    const key = path.slice('variants.'.length)
    delete (r.selectors.variants as Record<string, unknown>)[key]
  } else {
    delete (r.selectors as Record<string, unknown>)[path]
  }
  return r
}

describe('validateAndProfile — active', () => {
  it('a complete per-offer recipe (Shopify shape) resolves to active with no failures', () => {
    const result = validateAndProfile(makeRecipe())
    expect(result.status).toBe('active')
    expect(result.failures).toEqual([])
    expect(result.llmDeclaredFailed).toBe(false)
    expect(result.recipe.recipe_status).toBe('active')
  })

  it('a complete aggregate-range recipe (Woo shape, price_high present) resolves to active', () => {
    const result = validateAndProfile(makeAggregateRecipe())
    expect(result.status).toBe('active')
    expect(result.failures).toEqual([])
  })

  it("LLM 'active' + rules pass → active (positive control)", () => {
    const result = validateAndProfile(makeRecipe({ recipe_status: 'active' }))
    expect(result.status).toBe('active')
    expect(result.failures).toEqual([])
  })

  it('valid optional selectors present do not affect validity (still active)', () => {
    const result = validateAndProfile(
      makeRecipe({
        selectors: {
          title: makeFieldSelector({ selector: 'name', source: 'json' }),
          brand: makeFieldSelector({ strategy: 'css', selector: '.brand', source: 'text' }),
          sku: makeFieldSelector({ selector: 'sku', source: 'json' }),
          currency: makeFieldSelector({ selector: 'offers.0.priceCurrency', source: 'json' }),
          variants: makeVariants({
            ml: makeFieldSelector({ strategy: 'css', selector: 'h1', source: 'text', cleanup_regex: '(\\d+)\\s*ml' }),
          }),
        },
      }),
    )
    expect(result.status).toBe('active')
    expect(result.failures).toEqual([])
  })

  it('optionals left null do not affect validity (active)', () => {
    const result = validateAndProfile(makeRecipe())
    expect(result.status).toBe('active')
  })

  it("LLM 'stale' + rules pass → active (stale is treated as non-failed; rules decide)", () => {
    const result = validateAndProfile(makeRecipe({ recipe_status: 'stale' }))
    expect(result.status).toBe('active')
    expect(result.llmDeclaredFailed).toBe(false)
    expect(result.failures).toEqual([])
  })
})

describe('validateAndProfile — Rule 1: mandatory selectors (title + variants{container,price,availability})', () => {
  it.each(MANDATORY_FIELDS)('a MISSING mandatory selector (%s) → failed', (field) => {
    const result = validateAndProfile(recipeMissing(field))
    expect(result.status).toBe('failed')
    expect(result.recipe.recipe_status).toBe('failed')
    expect(result.failures).toContainEqual({ field, reason: 'mandatory_selector_missing' })
  })

  it('a DEGENERATE mandatory variant selector (whitespace-only selector) → failed', () => {
    const result = validateAndProfile(
      makeRecipe({
        selectors: {
          title: makeFieldSelector({ selector: 'name', source: 'json' }),
          brand: null,
          sku: null,
          currency: null,
          variants: makeVariants({ price: makeFieldSelector({ selector: '   ' }) }), // whitespace-only → not usable
        },
      }),
    )
    expect(result.status).toBe('failed')
    expect(result.failures).toContainEqual({ field: 'variants.price', reason: 'mandatory_selector_missing' })
  })
})

describe('validateAndProfile — Rule 2: attribute_name (all nine slots)', () => {
  it("source='attribute' on a mandatory variant slot WITHOUT attribute_name → failed", () => {
    const result = validateAndProfile(
      makeRecipe({
        selectors: {
          title: makeFieldSelector({ selector: 'name', source: 'json' }),
          brand: null,
          sku: null,
          currency: null,
          variants: makeVariants({
            price: makeFieldSelector({ source: 'attribute', attribute_name: null }),
          }),
        },
      }),
    )
    expect(result.status).toBe('failed')
    expect(result.failures).toContainEqual({ field: 'variants.price', reason: 'attribute_name_missing' })
  })

  it("source='attribute' WITH attribute_name → active (positive control)", () => {
    const result = validateAndProfile(
      makeRecipe({
        selectors: {
          title: makeFieldSelector({ selector: 'meta[itemprop=name]', source: 'attribute', attribute_name: 'content' }),
          brand: null,
          sku: null,
          currency: null,
          variants: makeVariants(),
        },
      }),
    )
    expect(result.status).toBe('active')
    expect(result.failures).toEqual([])
  })

  it("Rule 2 applies to OPTIONAL product slots too: brand source='attribute' without attribute_name → failed", () => {
    const result = validateAndProfile(
      makeRecipe({
        selectors: {
          title: makeFieldSelector({ selector: 'name', source: 'json' }),
          brand: makeFieldSelector({ selector: '[data-brand]', source: 'attribute', attribute_name: null }),
          sku: null,
          currency: null,
          variants: makeVariants(),
        },
      }),
    )
    expect(result.status).toBe('failed')
    expect(result.failures).toContainEqual({ field: 'brand', reason: 'attribute_name_missing' })
  })

  it("attribute_name = '  ' (whitespace) with source='attribute' → failed", () => {
    const result = validateAndProfile(
      makeRecipe({
        selectors: {
          title: makeFieldSelector({ selector: 'name', source: 'json' }),
          brand: null,
          sku: null,
          currency: null,
          variants: makeVariants({
            availability: makeFieldSelector({ source: 'attribute', attribute_name: '  ' }),
          }),
        },
      }),
    )
    expect(result.status).toBe('failed')
    expect(result.failures).toContainEqual({ field: 'variants.availability', reason: 'attribute_name_missing' })
  })
})

describe('validateAndProfile — Rule 3: price_high ↔ mode', () => {
  it('per-offer with a NON-NULL price_high → failed (price_high_mode_mismatch)', () => {
    const result = validateAndProfile(
      makeRecipe({
        selectors: {
          title: makeFieldSelector({ selector: 'name', source: 'json' }),
          brand: null,
          sku: null,
          currency: null,
          variants: makeVariants({
            mode: 'per-offer',
            price_high: makeFieldSelector({ selector: 'highPrice', source: 'json' }),
          }),
        },
      }),
    )
    expect(result.status).toBe('failed')
    expect(result.failures).toContainEqual({
      field: 'variants.price_high',
      reason: 'price_high_mode_mismatch',
    })
  })

  it('aggregate-range WITH price_high → active (the expected Woo shape)', () => {
    const result = validateAndProfile(makeAggregateRecipe())
    expect(result.status).toBe('active')
    expect(result.failures).toEqual([])
  })

  it('aggregate-range WITHOUT price_high (null) → active (inverse is NOT enforced)', () => {
    const result = validateAndProfile(
      makeAggregateRecipe({
        selectors: {
          title: makeFieldSelector({ selector: 'name', source: 'json' }),
          brand: null,
          sku: makeFieldSelector({ selector: 'sku', source: 'json' }),
          currency: null,
          variants: makeVariants({
            mode: 'aggregate-range',
            container: makeFieldSelector({ selector: 'offers.0', source: 'json' }),
            price: makeFieldSelector({ selector: 'lowPrice', source: 'json' }),
            price_high: null,
          }),
        },
      }),
    )
    expect(result.status).toBe('active')
    expect(result.failures).toEqual([])
  })
})

describe('validateAndProfile — Rule 2 does NOT fire for ml lifted from title/URL (Shopify pattern, blindado)', () => {
  it("variants.ml with source='text' + cleanup_regex resolves active and never trips attribute_name_missing", () => {
    const result = validateAndProfile(
      makeRecipe({
        selectors: {
          title: makeFieldSelector({ selector: 'name', source: 'json' }),
          brand: null,
          sku: null,
          currency: null,
          variants: makeVariants({
            // The size is not a JSON-LD field on Shopify; lift it from the title
            // text via a cleanup_regex. source='text' (NOT 'attribute') ⇒ Rule 2
            // must NOT require an attribute_name here.
            ml: makeFieldSelector({
              strategy: 'css',
              selector: 'h1.product-single__title',
              source: 'text',
              attribute_name: null,
              cleanup_regex: '(\\d+)\\s*ml',
            }),
          }),
        },
      }),
    )
    expect(result.status).toBe('active')
    expect(result.failures).toEqual([])
    expect(
      result.failures.some((f) => f.reason === 'attribute_name_missing'),
    ).toBe(false)
  })
})

describe('validateAndProfile — extraction_confidence does NOT gate status', () => {
  it('mandatory selectors at confidence "low" stay active (decision: A4 marks stale on execution)', () => {
    const result = validateAndProfile(
      makeRecipe({
        selectors: {
          title: makeFieldSelector({ selector: 'name', source: 'json', extraction_confidence: 'low' }),
          brand: null,
          sku: null,
          currency: null,
          variants: makeVariants({
            container: makeFieldSelector({ selector: 'offers', source: 'json', extraction_confidence: 'low' }),
            price: makeFieldSelector({ selector: 'price', source: 'json', extraction_confidence: 'low' }),
            availability: makeFieldSelector({ selector: 'availability', source: 'json', extraction_confidence: 'low' }),
          }),
        },
      }),
    )
    expect(result.status).toBe('active')
    expect(result.failures).toEqual([])
  })
})

describe('validateAndProfile — status floor (re-derivation never promotes failed→active)', () => {
  it("LLM 'active' but a mandatory is missing → 'failed' (code DEGRADES)", () => {
    const result = validateAndProfile(
      recipeWithSelectors(recipeMissing('variants.price').selectors, { recipe_status: 'active' }),
    )
    expect(result.status).toBe('failed')
    expect(result.recipe.recipe_status).toBe('failed')
    expect(result.llmDeclaredFailed).toBe(false)
  })

  it("LLM 'failed' + structurally complete selectors → 'failed' (floor; never promoted)", () => {
    const result = validateAndProfile(makeRecipe({ recipe_status: 'failed' }))
    expect(result.status).toBe('failed')
    expect(result.recipe.recipe_status).toBe('failed')
    expect(result.llmDeclaredFailed).toBe(true)
    // No rule failure — the floor alone drove the verdict.
    expect(result.failures).toEqual([])
  })

  it("LLM 'failed' AND rules also fail → 'failed' with BOTH causes reported", () => {
    const result = validateAndProfile(
      recipeWithSelectors(recipeMissing('title').selectors, { recipe_status: 'failed' }),
    )
    expect(result.status).toBe('failed')
    expect(result.llmDeclaredFailed).toBe(true) // semantic floor
    expect(result.failures).toContainEqual({ field: 'title', reason: 'mandatory_selector_missing' }) // structural
  })

  it('reports one failure entry per offending slot (missing title + bad attribute price)', () => {
    const result = validateAndProfile(
      recipeWithSelectors({
        // title missing
        brand: null,
        sku: null,
        currency: null,
        variants: makeVariants({
          price: makeFieldSelector({ source: 'attribute', attribute_name: null }),
        }),
      }),
    )
    expect(result.status).toBe('failed')
    expect(result.failures).toHaveLength(2)
    expect(result.failures).toContainEqual({ field: 'title', reason: 'mandatory_selector_missing' })
    expect(result.failures).toContainEqual({ field: 'variants.price', reason: 'attribute_name_missing' })
  })

  it('is deterministic — same input yields the same result', () => {
    const recipe = makeRecipe()
    expect(JSON.stringify(validateAndProfile(recipe))).toBe(
      JSON.stringify(validateAndProfile(recipe)),
    )
  })
})
