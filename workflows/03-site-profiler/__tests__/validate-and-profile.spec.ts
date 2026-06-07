/**
 * Unit tests for validateAndProfile (A3 — Site Profiler).
 *
 * Pure: from a SiteRecipe (already Zod-validated upstream) → resolved
 * recipe_status + per-slot structural failures + the model's 'failed' floor.
 * No Postgres, no OpenAI, no Bright Data. Mirrors
 * 02-sourcing-scout/__tests__/validate-and-filter.spec.ts.
 *
 * The two cross-field rules under test are the ones SiteRecipeSchema documents
 * but does not enforce; Rule 1 is also structurally guaranteed by Zod, so the
 * "missing mandatory" cases feed a deliberately-degenerate shape via a cast,
 * exactly as A2's spec deletes required fields before re-parsing.
 *
 * STATUS is re-derived WITH A FLOOR: 'failed' if a structural rule fails OR the
 * model emitted recipe_status='failed'. The code degrades active→failed but
 * never promotes failed→active.
 */

import {
  MANDATORY_FIELDS,
  validateAndProfile,
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

const makeRecipe = (o: Partial<SiteRecipe> = {}): SiteRecipe => ({
  search_url_template: '?s=<query>',
  selectors: {
    title: makeFieldSelector({ selector: 'h1.product-title', source: 'text' }),
    price: makeFieldSelector(),
    stock: makeFieldSelector({ selector: 'offers.availability' }),
    currency: null,
    ml: null,
    sku: null,
  },
  recipe_status: 'active',
  ...o,
})

/** Build a recipe whose `selectors` is overridden wholesale (allows degenerate shapes). */
const recipeWithSelectors = (
  selectors: unknown,
  overrides: Partial<SiteRecipe> = {},
): SiteRecipe => ({ ...makeRecipe(overrides), selectors } as SiteRecipe)

describe('validateAndProfile — active', () => {
  it('a complete recipe (3 mandatory + optionals null) resolves to active with no failures', () => {
    const result = validateAndProfile(makeRecipe())
    expect(result.status).toBe('active')
    expect(result.failures).toEqual([])
    expect(result.llmDeclaredFailed).toBe(false)
    expect(result.recipe.recipe_status).toBe('active')
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
          title: makeFieldSelector({ selector: 'h1', source: 'text' }),
          price: makeFieldSelector(),
          stock: makeFieldSelector({ selector: 'offers.availability' }),
          currency: makeFieldSelector({ strategy: 'css', selector: '.cur', source: 'text' }),
          ml: makeFieldSelector({ strategy: 'css', selector: 'h1', source: 'text', cleanup_regex: '(\\d+)\\s*ml' }),
          sku: makeFieldSelector({ selector: 'sku' }),
        },
      }),
    )
    expect(result.status).toBe('active')
    expect(result.failures).toEqual([])
  })

  it('optionals left null do not affect validity (active)', () => {
    const result = validateAndProfile(
      makeRecipe({
        selectors: {
          title: makeFieldSelector({ source: 'text' }),
          price: makeFieldSelector(),
          stock: makeFieldSelector(),
          currency: null,
          ml: null,
          sku: null,
        },
      }),
    )
    expect(result.status).toBe('active')
  })

  it("LLM 'stale' + rules pass → active (stale is treated as non-failed; rules decide)", () => {
    const result = validateAndProfile(makeRecipe({ recipe_status: 'stale' }))
    expect(result.status).toBe('active')
    expect(result.llmDeclaredFailed).toBe(false)
    expect(result.failures).toEqual([])
  })
})

describe('validateAndProfile — Rule 1: mandatory selectors', () => {
  it.each(MANDATORY_FIELDS)('a MISSING mandatory selector (%s) → failed', (field) => {
    const selectors = { ...makeRecipe().selectors }
    delete (selectors as Record<string, unknown>)[field]
    const result = validateAndProfile(recipeWithSelectors(selectors))
    expect(result.status).toBe('failed')
    expect(result.recipe.recipe_status).toBe('failed')
    expect(result.failures).toContainEqual({ field, reason: 'mandatory_selector_missing' })
  })

  it('a DEGENERATE mandatory selector (whitespace-only selector) → failed', () => {
    const result = validateAndProfile(
      makeRecipe({
        selectors: {
          title: makeFieldSelector({ selector: 'h1', source: 'text' }),
          price: makeFieldSelector(),
          stock: makeFieldSelector({ selector: '   ' }), // whitespace-only → not usable
          currency: null,
          ml: null,
          sku: null,
        },
      }),
    )
    expect(result.status).toBe('failed')
    expect(result.failures).toContainEqual({ field: 'stock', reason: 'mandatory_selector_missing' })
  })
})

describe('validateAndProfile — Rule 2: attribute_name', () => {
  it("source='attribute' on a mandatory WITHOUT attribute_name → failed", () => {
    const result = validateAndProfile(
      makeRecipe({
        selectors: {
          title: makeFieldSelector({ selector: 'h1', source: 'text' }),
          price: makeFieldSelector({ source: 'attribute', attribute_name: null }),
          stock: makeFieldSelector(),
          currency: null,
          ml: null,
          sku: null,
        },
      }),
    )
    expect(result.status).toBe('failed')
    expect(result.failures).toContainEqual({ field: 'price', reason: 'attribute_name_missing' })
  })

  it("source='attribute' WITH attribute_name → active (positive control)", () => {
    const result = validateAndProfile(
      makeRecipe({
        selectors: {
          title: makeFieldSelector({ selector: 'meta[itemprop=name]', source: 'attribute', attribute_name: 'content' }),
          price: makeFieldSelector(),
          stock: makeFieldSelector(),
          currency: null,
          ml: null,
          sku: null,
        },
      }),
    )
    expect(result.status).toBe('active')
    expect(result.failures).toEqual([])
  })

  it("Rule 2 applies to OPTIONAL slots too: sku source='attribute' without attribute_name → failed", () => {
    const result = validateAndProfile(
      makeRecipe({
        selectors: {
          title: makeFieldSelector({ source: 'text' }),
          price: makeFieldSelector(),
          stock: makeFieldSelector(),
          currency: null,
          ml: null,
          sku: makeFieldSelector({ selector: '[data-sku]', source: 'attribute', attribute_name: null }),
        },
      }),
    )
    expect(result.status).toBe('failed')
    expect(result.failures).toContainEqual({ field: 'sku', reason: 'attribute_name_missing' })
  })

  it("attribute_name = '  ' (whitespace) with source='attribute' → failed", () => {
    const result = validateAndProfile(
      makeRecipe({
        selectors: {
          title: makeFieldSelector({ source: 'text' }),
          price: makeFieldSelector({ source: 'attribute', attribute_name: '  ' }),
          stock: makeFieldSelector(),
          currency: null,
          ml: null,
          sku: null,
        },
      }),
    )
    expect(result.status).toBe('failed')
    expect(result.failures).toContainEqual({ field: 'price', reason: 'attribute_name_missing' })
  })
})

describe('validateAndProfile — extraction_confidence does NOT gate status', () => {
  it('a mandatory selector at confidence "low" stays active (decision: A4 marks stale on execution)', () => {
    const result = validateAndProfile(
      makeRecipe({
        selectors: {
          title: makeFieldSelector({ selector: 'h1', source: 'text', extraction_confidence: 'low' }),
          price: makeFieldSelector({ extraction_confidence: 'low' }),
          stock: makeFieldSelector({ extraction_confidence: 'low' }),
          currency: null,
          ml: null,
          sku: null,
        },
      }),
    )
    expect(result.status).toBe('active')
    expect(result.failures).toEqual([])
  })
})

describe('validateAndProfile — status floor (re-derivation never promotes failed→active)', () => {
  it("LLM 'active' but a mandatory is missing → 'failed' (code DEGRADES)", () => {
    const selectors = { ...makeRecipe().selectors }
    delete (selectors as Record<string, unknown>).price
    const result = validateAndProfile(recipeWithSelectors(selectors, { recipe_status: 'active' }))
    expect(result.status).toBe('failed')
    expect(result.recipe.recipe_status).toBe('failed')
    expect(result.llmDeclaredFailed).toBe(false)
  })

  it("LLM 'failed' + structurally complete selectors → 'failed' (floor; never promoted)", () => {
    const result = validateAndProfile(makeRecipe({ recipe_status: 'failed' }))
    expect(result.status).toBe('failed')
    expect(result.recipe.recipe_status).toBe('failed')
    expect(result.llmDeclaredFailed).toBe(true)
    // No STRUCTURAL failure — the floor alone drove the verdict.
    expect(result.failures).toEqual([])
  })

  it("LLM 'failed' AND rules also fail → 'failed' with BOTH causes reported", () => {
    const selectors = { ...makeRecipe().selectors }
    delete (selectors as Record<string, unknown>).title
    const result = validateAndProfile(recipeWithSelectors(selectors, { recipe_status: 'failed' }))
    expect(result.status).toBe('failed')
    expect(result.llmDeclaredFailed).toBe(true) // semantic floor
    expect(result.failures).toContainEqual({ field: 'title', reason: 'mandatory_selector_missing' }) // structural
  })

  it('reports one failure entry per offending slot (missing title + bad attribute price)', () => {
    const result = validateAndProfile(
      recipeWithSelectors({
        // title missing
        price: makeFieldSelector({ source: 'attribute', attribute_name: null }),
        stock: makeFieldSelector(),
        currency: null,
        ml: null,
        sku: null,
      }),
    )
    expect(result.status).toBe('failed')
    expect(result.failures).toHaveLength(2)
    expect(result.failures).toContainEqual({ field: 'title', reason: 'mandatory_selector_missing' })
    expect(result.failures).toContainEqual({ field: 'price', reason: 'attribute_name_missing' })
  })

  it('is deterministic — same input yields the same result', () => {
    const recipe = makeRecipe()
    expect(JSON.stringify(validateAndProfile(recipe))).toBe(
      JSON.stringify(validateAndProfile(recipe)),
    )
  })
})
