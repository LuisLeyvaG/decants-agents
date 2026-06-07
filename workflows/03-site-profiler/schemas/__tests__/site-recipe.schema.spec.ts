/**
 * Unit tests for the Site Profiler (Agente 3) Zod contract AND its GENERATED
 * OpenAI Structured Outputs JSON Schema.
 *
 * Two halves, calqued from the two A1/A2 precedents:
 *   1. Zod structural contract — mirrors 02-sourcing-scout/schemas/
 *      provider.schema.spec.ts: a valid baseline, the nullable fields, the
 *      enums, and boundary rejections. The schema is PURELY STRUCTURAL: the two
 *      cross-field rules (active ⇔ title/price/stock well-formed;
 *      attribute_name required when source='attribute') live downstream in the
 *      validateAndFilter mirror, NOT here, so they are deliberately NOT tested
 *      in this file.
 *   2. Generated JSON Schema integrity — mirrors scripts/__tests__/
 *      build-output-schema.spec.ts. These require `npm run build:schema` first;
 *      the `pretest` hook automates it. They assert the nested FieldSelector
 *      survives OpenAI strict mode: every object level (root, selectors, and
 *      every FieldSelector — including the three reached through a nullable
 *      `anyOf`) declares `additionalProperties: false`, lists ALL its keys in
 *      `required[]`, and carries no `format: "uri"`.
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

const makeRecipe = (overrides: Partial<SiteRecipe> = {}): SiteRecipe => ({
  search_url_template: '?s=<query>',
  selectors: {
    title: makeFieldSelector({ selector: 'h1.product-title', source: 'text' }),
    price: makeFieldSelector(),
    stock: makeFieldSelector({ selector: 'offers.availability', source: 'json' }),
    currency: null,
    ml: null,
    sku: null,
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
  it('accepts a fully populated baseline recipe', () => {
    expect(SiteRecipeSchema.safeParse(makeRecipe()).success).toBe(true)
  })

  it('accepts search_url_template = null (no navigable search pattern)', () => {
    expect(SiteRecipeSchema.safeParse(makeRecipe({ search_url_template: null })).success).toBe(true)
  })

  it('accepts the optional selectors (currency/ml/sku) set to null', () => {
    const result = SiteRecipeSchema.safeParse(
      makeRecipe({
        selectors: {
          title: makeFieldSelector(),
          price: makeFieldSelector(),
          stock: makeFieldSelector(),
          currency: null,
          ml: null,
          sku: null,
        },
      }),
    )
    expect(result.success).toBe(true)
  })

  it('accepts the optional selectors as FieldSelector objects', () => {
    const result = SiteRecipeSchema.safeParse(
      makeRecipe({
        selectors: {
          title: makeFieldSelector(),
          price: makeFieldSelector(),
          stock: makeFieldSelector(),
          currency: makeFieldSelector({ strategy: 'css', selector: '.price .currency', source: 'text' }),
          ml: makeFieldSelector({ strategy: 'css', selector: 'h1', source: 'text', cleanup_regex: '(\\d+)\\s*ml' }),
          sku: makeFieldSelector({ source: 'json', selector: 'sku' }),
        },
      }),
    )
    expect(result.success).toBe(true)
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

  it('rejects an empty (non-null) search_url_template', () => {
    expect(SiteRecipeSchema.safeParse(makeRecipe({ search_url_template: '' })).success).toBe(false)
  })

  it('rejects a missing mandatory selector (price)', () => {
    const recipe = makeRecipe()
    const selectors: Partial<SiteRecipe['selectors']> = { ...recipe.selectors }
    delete selectors.price
    const result = SiteRecipeSchema.safeParse({ ...recipe, selectors })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path)).toContainEqual(['selectors', 'price'])
    }
  })

  it('rejects a null mandatory selector (title is non-nullable)', () => {
    const recipe = makeRecipe()
    const result = SiteRecipeSchema.safeParse({
      ...recipe,
      selectors: { ...recipe.selectors, title: null as never },
    })
    expect(result.success).toBe(false)
  })

  it('rejects a malformed nested selector (empty selector string)', () => {
    const recipe = makeRecipe()
    const result = SiteRecipeSchema.safeParse({
      ...recipe,
      selectors: { ...recipe.selectors, stock: makeFieldSelector({ selector: '' }) },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path)).toContainEqual(['selectors', 'stock', 'selector'])
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
// currency/ml/sku branches ARE visited.
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

  it('has exactly 8 object nodes: root + selectors + 6 FieldSelectors (nesting is bounded)', () => {
    // Pins the nested shape we deliberately isolated this sprint: if a future
    // change adds/removes a selector or an object level, this count breaks and
    // forces a re-check against OpenAI strict mode.
    expect([...walkObjectNodes(loadGeneratedSchema().schema)]).toHaveLength(8)
  })

  it('each of the 6 FieldSelector nodes is fully required + closed', () => {
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
    expect(selectorNodes).toHaveLength(6)
    for (const node of selectorNodes) {
      expect(node.additionalProperties).toBe(false)
      expect([...(node.required as string[])].sort()).toEqual(fieldSelectorKeys)
    }
  })

  it('selectors object requires all six fields including the optional nullable ones', () => {
    const env = loadGeneratedSchema()
    const selectors = (env.schema.properties as Record<string, unknown>)
      .selectors as Record<string, unknown>
    expect([...(selectors.required as string[])].sort()).toEqual(
      ['currency', 'ml', 'price', 'sku', 'stock', 'title'].sort(),
    )
    expect(selectors.additionalProperties).toBe(false)
  })
})
