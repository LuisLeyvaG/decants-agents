/**
 * Unit tests for the Site Profiler (Agente 3) Zod contract AND its GENERATED
 * OpenAI Structured Outputs JSON Schema.
 *
 * Two halves, calqued from the two A1/A2 precedents:
 *   1. Zod structural contract — mirrors 02-sourcing-scout/schemas/
 *      provider.schema.spec.ts: a valid baseline, the nullable fields, the
 *      enums, and boundary rejections — now over the nested `variants`
 *      dimension. The schema is PURELY STRUCTURAL: the three cross-field rules
 *      (active ⇔ title + variants{container,price,availability} well-formed;
 *      attribute_name required when source='attribute'; price_high only under
 *      aggregate-range) live downstream in the validateAndProfile mirror, NOT
 *      here, so they are deliberately NOT tested in this file.
 *   2. Generated JSON Schema integrity — mirrors scripts/__tests__/
 *      build-output-schema.spec.ts. These require `npm run build:schema` first;
 *      the `pretest` hook automates it. They assert the nested shape survives
 *      OpenAI strict mode: EVERY object level (root, selectors, variants, and
 *      every one of the 9 FieldSelectors — including those reached through a
 *      nullable `anyOf`) declares `additionalProperties: false`, lists ALL its
 *      keys in `required[]`, carries no `format: "uri"`, and the file has no
 *      `$ref`.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  EXTRACTION_CONFIDENCE_VALUES,
  FIELD_SOURCE_VALUES,
  FieldSelectorSchema,
  RECIPE_STATUS_VALUES,
  STRATEGY_VALUES,
  SiteRecipeSchema,
  VARIANT_MODE_VALUES,
  type FieldSelector,
  type SiteRecipe,
} from '../site-recipe.schema'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeFieldSelector = (
  overrides: Partial<FieldSelector> = {},
): FieldSelector => ({
  strategy: 'json-ld',
  selector: 'offers.price',
  source: 'json',
  attribute_name: null,
  cleanup_regex: null,
  extraction_confidence: 'high',
  ...overrides,
})

const makeVariants = (
  overrides: Partial<SiteRecipe['selectors']['variants']> = {},
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
  ...overrides,
})

const makeRecipe = (overrides: Partial<SiteRecipe> = {}): SiteRecipe => ({
  search_url_template: '?s=<query>',
  selectors: {
    title: makeFieldSelector({ selector: 'name', source: 'json' }),
    brand: null,
    sku: null,
    currency: null,
    variants: makeVariants(),
  },
  recipe_status: 'active',
  ...overrides,
})

// ===========================================================================
// 1. Zod structural contract
// ===========================================================================

describe('FieldSelectorSchema — valid', () => {
  it('accepts a fully populated baseline selector', () => {
    expect(FieldSelectorSchema.safeParse(makeFieldSelector()).success).toBe(true)
  })

  it('accepts attribute_name / cleanup_regex set to null', () => {
    const result = FieldSelectorSchema.safeParse(
      makeFieldSelector({ attribute_name: null, cleanup_regex: null }),
    )
    expect(result.success).toBe(true)
  })

  it('accepts attribute_name / cleanup_regex as non-empty strings', () => {
    const result = FieldSelectorSchema.safeParse(
      makeFieldSelector({
        source: 'attribute',
        attribute_name: 'content',
        cleanup_regex: '(\\d+)\\s*ml',
      }),
    )
    expect(result.success).toBe(true)
  })

  it.each(STRATEGY_VALUES)('accepts strategy %s', (strategy) => {
    expect(FieldSelectorSchema.safeParse(makeFieldSelector({ strategy })).success).toBe(true)
  })

  it.each(FIELD_SOURCE_VALUES)('accepts source %s', (source) => {
    expect(FieldSelectorSchema.safeParse(makeFieldSelector({ source })).success).toBe(true)
  })

  it.each(EXTRACTION_CONFIDENCE_VALUES)('accepts extraction_confidence %s', (extraction_confidence) => {
    expect(
      FieldSelectorSchema.safeParse(makeFieldSelector({ extraction_confidence })).success,
    ).toBe(true)
  })
})

describe('FieldSelectorSchema — invalid', () => {
  it('rejects a strategy outside the enum', () => {
    expect(
      FieldSelectorSchema.safeParse(makeFieldSelector({ strategy: 'regex' as never })).success,
    ).toBe(false)
  })

  it('rejects a source outside the enum', () => {
    expect(
      FieldSelectorSchema.safeParse(makeFieldSelector({ source: 'href' as never })).success,
    ).toBe(false)
  })

  it('rejects an extraction_confidence outside the enum', () => {
    expect(
      FieldSelectorSchema.safeParse(
        makeFieldSelector({ extraction_confidence: 'unknown' as never }),
      ).success,
    ).toBe(false)
  })

  it('rejects an empty selector', () => {
    expect(FieldSelectorSchema.safeParse(makeFieldSelector({ selector: '' })).success).toBe(false)
  })

  it('rejects an empty (non-null) attribute_name', () => {
    expect(
      FieldSelectorSchema.safeParse(makeFieldSelector({ attribute_name: '' })).success,
    ).toBe(false)
  })

  it('rejects a missing strategy key (must be explicitly present)', () => {
    const payload: Partial<FieldSelector> = makeFieldSelector()
    delete payload.strategy
    expect(FieldSelectorSchema.safeParse(payload).success).toBe(false)
  })
})

describe('SiteRecipeSchema — valid', () => {
  it('accepts a fully populated baseline recipe (per-offer)', () => {
    expect(SiteRecipeSchema.safeParse(makeRecipe()).success).toBe(true)
  })

  it('accepts an aggregate-range recipe with a non-null price_high (Woo shape)', () => {
    const result = SiteRecipeSchema.safeParse(
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
      }),
    )
    expect(result.success).toBe(true)
  })

  it('accepts search_url_template = null (no navigable search pattern)', () => {
    expect(SiteRecipeSchema.safeParse(makeRecipe({ search_url_template: null })).success).toBe(true)
  })

  it('accepts the optional product selectors (brand/sku/currency) and variants.ml/price_high set to null', () => {
    const result = SiteRecipeSchema.safeParse(
      makeRecipe({
        selectors: {
          title: makeFieldSelector({ selector: 'name', source: 'json' }),
          brand: null,
          sku: null,
          currency: null,
          variants: makeVariants({ ml: null, price_high: null }),
        },
      }),
    )
    expect(result.success).toBe(true)
  })

  it('accepts the optional selectors as FieldSelector objects (brand/sku/currency + variants.ml)', () => {
    const result = SiteRecipeSchema.safeParse(
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
    expect(result.success).toBe(true)
  })

  it.each(VARIANT_MODE_VALUES)('accepts variants.mode %s', (mode) => {
    expect(
      SiteRecipeSchema.safeParse(
        makeRecipe({
          selectors: {
            title: makeFieldSelector({ selector: 'name', source: 'json' }),
            brand: null,
            sku: null,
            currency: null,
            variants: makeVariants({ mode }),
          },
        }),
      ).success,
    ).toBe(true)
  })

  it.each(RECIPE_STATUS_VALUES)('accepts recipe_status %s', (recipe_status) => {
    expect(SiteRecipeSchema.safeParse(makeRecipe({ recipe_status })).success).toBe(true)
  })
})

describe('SiteRecipeSchema — invalid', () => {
  it('rejects a recipe_status outside the enum', () => {
    expect(SiteRecipeSchema.safeParse(makeRecipe({ recipe_status: 'expired' as never })).success).toBe(
      false,
    )
  })

  it('rejects a variants.mode outside the enum', () => {
    const recipe = makeRecipe()
    const result = SiteRecipeSchema.safeParse({
      ...recipe,
      selectors: {
        ...recipe.selectors,
        variants: { ...recipe.selectors.variants, mode: 'single' as never },
      },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path)).toContainEqual(['selectors', 'variants', 'mode'])
    }
  })

  it('rejects an empty (non-null) search_url_template', () => {
    expect(SiteRecipeSchema.safeParse(makeRecipe({ search_url_template: '' })).success).toBe(false)
  })

  it('rejects a missing mandatory product selector (title)', () => {
    const recipe = makeRecipe()
    const selectors: Partial<SiteRecipe['selectors']> = { ...recipe.selectors }
    delete selectors.title
    const result = SiteRecipeSchema.safeParse({ ...recipe, selectors })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path)).toContainEqual(['selectors', 'title'])
    }
  })

  it('rejects a null mandatory product selector (title is non-nullable)', () => {
    const recipe = makeRecipe()
    const result = SiteRecipeSchema.safeParse({
      ...recipe,
      selectors: { ...recipe.selectors, title: null as never },
    })
    expect(result.success).toBe(false)
  })

  it('rejects a missing mandatory variant selector (variants.price) — nested path', () => {
    const recipe = makeRecipe()
    const variants: Partial<SiteRecipe['selectors']['variants']> = {
      ...recipe.selectors.variants,
    }
    delete variants.price
    const result = SiteRecipeSchema.safeParse({
      ...recipe,
      selectors: { ...recipe.selectors, variants },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path)).toContainEqual(['selectors', 'variants', 'price'])
    }
  })

  it('rejects a null mandatory variant selector (variants.container is non-nullable)', () => {
    const recipe = makeRecipe()
    const result = SiteRecipeSchema.safeParse({
      ...recipe,
      selectors: {
        ...recipe.selectors,
        variants: { ...recipe.selectors.variants, container: null as never },
      },
    })
    expect(result.success).toBe(false)
  })

  it('rejects a malformed nested variant selector (empty selector string) — nested path', () => {
    const recipe = makeRecipe()
    const result = SiteRecipeSchema.safeParse({
      ...recipe,
      selectors: {
        ...recipe.selectors,
        variants: { ...recipe.selectors.variants, availability: makeFieldSelector({ selector: '' }) },
      },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path)).toContainEqual([
        'selectors',
        'variants',
        'availability',
        'selector',
      ])
    }
  })

  it('rejects a missing variants object entirely', () => {
    const recipe = makeRecipe()
    const selectors: Partial<SiteRecipe['selectors']> = { ...recipe.selectors }
    delete selectors.variants
    const result = SiteRecipeSchema.safeParse({ ...recipe, selectors })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path)).toContainEqual(['selectors', 'variants'])
    }
  })

  it('rejects a missing recipe_status key', () => {
    const recipe: Partial<SiteRecipe> = makeRecipe()
    delete recipe.recipe_status
    expect(SiteRecipeSchema.safeParse(recipe).success).toBe(false)
  })
})

// ===========================================================================
// 2. Generated OpenAI JSON Schema integrity
//    (requires `npm run build:schema` — automated by the `pretest` hook)
// ===========================================================================

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const SCHEMA_PATH = resolve(__dirname, '..', 'site-recipe.schema.json')

interface OpenAIEnvelope {
  name: string
  strict: boolean
  schema: Record<string, unknown>
}

const loadGeneratedSchema = (): OpenAIEnvelope =>
  JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8')) as OpenAIEnvelope

// Recursively walk a JSON Schema tree, yielding every node that has
// `type === 'object'`. Calqued from build-output-schema.spec.ts. Recurses into
// `anyOf` arrays too, so the FieldSelector objects nested under the nullable
// brand/sku/currency and variants.ml/price_high branches ARE visited.
function* walkObjectNodes(
  node: unknown,
): Generator<Record<string, unknown>, void, undefined> {
  if (Array.isArray(node)) {
    for (const item of node) yield* walkObjectNodes(item)
    return
  }
  if (node !== null && typeof node === 'object') {
    const obj = node as Record<string, unknown>
    if (obj.type === 'object') yield obj
    for (const v of Object.values(obj)) yield* walkObjectNodes(v)
  }
}

// Walk EVERY object-shaped node (regardless of `type`), used for the
// no-format-uri invariant which must hold on string nodes too.
function* walkAllNodes(
  node: unknown,
): Generator<Record<string, unknown>, void, undefined> {
  if (Array.isArray(node)) {
    for (const item of node) yield* walkAllNodes(item)
    return
  }
  if (node !== null && typeof node === 'object') {
    const obj = node as Record<string, unknown>
    yield obj
    for (const v of Object.values(obj)) yield* walkAllNodes(v)
  }
}

describe('Generated OpenAI JSON Schema — envelope', () => {
  it('has exactly 3 top-level keys: name, strict, schema', () => {
    expect(Object.keys(loadGeneratedSchema()).sort()).toEqual(['name', 'schema', 'strict'])
  })

  it('strict mode is enabled (strict === true)', () => {
    expect(loadGeneratedSchema().strict).toBe(true)
  })

  it("name === 'site_recipe'", () => {
    expect(loadGeneratedSchema().name).toBe('site_recipe')
  })

  it('root schema is an object type', () => {
    expect(loadGeneratedSchema().schema.type).toBe('object')
  })

  it('contains no $ref anywhere (OpenAI Structured Outputs rejects refs)', () => {
    expect(readFileSync(SCHEMA_PATH, 'utf-8')).not.toMatch(/"\$ref"/)
  })
})

describe('Generated OpenAI JSON Schema — strict-mode invariants at every object level', () => {
  it('every object node declares additionalProperties: false', () => {
    const objectNodes = [...walkObjectNodes(loadGeneratedSchema().schema)]
    expect(objectNodes.length).toBeGreaterThan(0)
    for (const node of objectNodes) {
      expect(node.additionalProperties).toBe(false)
    }
  })

  it("every object's required[] equals Object.keys(properties)", () => {
    const objectNodes = [...walkObjectNodes(loadGeneratedSchema().schema)]
    for (const node of objectNodes) {
      const props = node.properties as Record<string, unknown> | undefined
      const required = node.required as string[] | undefined
      expect(props).toBeDefined()
      expect(required).toBeDefined()
      expect([...(required ?? [])].sort()).toEqual(Object.keys(props ?? {}).sort())
    }
  })

  it('no node anywhere carries format: "uri" (OpenAI strict rejects it)', () => {
    for (const node of walkAllNodes(loadGeneratedSchema().schema)) {
      expect(node.format).not.toBe('uri')
    }
    expect(readFileSync(SCHEMA_PATH, 'utf-8')).not.toMatch(/"format"\s*:\s*"uri"/)
  })

  it('has exactly 12 object nodes: root + selectors + variants + 9 FieldSelectors (nesting is bounded)', () => {
    // Pins the nested shape this sprint introduced (the variants dimension): if a
    // future change adds/removes a selector or an object level, this count breaks
    // and forces a re-check against OpenAI strict mode.
    //   root(1) + selectors(1) + variants(1)
    //   + 4 product FieldSelectors (title, brand, sku, currency)
    //   + 5 variant FieldSelectors (container, ml, price, price_high, availability)
    //   = 12
    expect([...walkObjectNodes(loadGeneratedSchema().schema)]).toHaveLength(12)
  })

  it('each of the 9 FieldSelector nodes is fully required + closed', () => {
    const fieldSelectorKeys = [
      'strategy',
      'selector',
      'source',
      'attribute_name',
      'cleanup_regex',
      'extraction_confidence',
    ].sort()
    const selectorNodes = [...walkObjectNodes(loadGeneratedSchema().schema)].filter((node) => {
      const props = node.properties as Record<string, unknown> | undefined
      return props !== undefined && Object.keys(props).includes('strategy')
    })
    expect(selectorNodes).toHaveLength(9)
    for (const node of selectorNodes) {
      expect(node.additionalProperties).toBe(false)
      expect([...(node.required as string[])].sort()).toEqual(fieldSelectorKeys)
    }
  })

  it('selectors object requires title, brand, sku, currency, variants and is closed', () => {
    const env = loadGeneratedSchema()
    const selectors = (env.schema.properties as Record<string, unknown>)
      .selectors as Record<string, unknown>
    expect([...(selectors.required as string[])].sort()).toEqual(
      ['brand', 'currency', 'sku', 'title', 'variants'].sort(),
    )
    expect(selectors.additionalProperties).toBe(false)
  })

  it('variants object requires mode, container, ml, price, price_high, availability and is closed', () => {
    const env = loadGeneratedSchema()
    const selectors = (env.schema.properties as Record<string, unknown>)
      .selectors as Record<string, unknown>
    const variants = (selectors.properties as Record<string, unknown>)
      .variants as Record<string, unknown>
    expect([...(variants.required as string[])].sort()).toEqual(
      ['availability', 'container', 'ml', 'mode', 'price', 'price_high'].sort(),
    )
    expect(variants.additionalProperties).toBe(false)
  })
})
