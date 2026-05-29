/**
 * Tests verify the GENERATED JSON Schema file. They require:
 *
 *   npm run build:schema
 *
 * to be run BEFORE these tests. The `pretest` hook in package.json
 * automates this — CI runs `npm test` and the schema is regenerated
 * automatically. Run the build manually if you want to inspect the
 * artifact without invoking jest.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const SCHEMA_PATH = resolve(
  __dirname,
  '..',
  '..',
  '01-trend-analyst',
  'schemas',
  'trend-analyst-output.schema.json',
)

interface OpenAIEnvelope {
  name: string
  strict: boolean
  schema: Record<string, unknown>
}

const loadGeneratedSchema = (): OpenAIEnvelope => {
  const raw = readFileSync(SCHEMA_PATH, 'utf-8')
  return JSON.parse(raw) as OpenAIEnvelope
}

// Recursively walk a JSON Schema tree, yielding every node that has
// `type === 'object'`. Used by the object-shape invariants below.
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

describe('Generated OpenAI JSON Schema integrity', () => {
  it('has exactly 3 top-level keys: name, strict, schema', () => {
    const env = loadGeneratedSchema()
    expect(Object.keys(env).sort()).toEqual(['name', 'schema', 'strict'])
  })

  it('strict mode is enabled (strict === true)', () => {
    const env = loadGeneratedSchema()
    expect(env.strict).toBe(true)
  })

  it("name === 'trend_analyst_output'", () => {
    const env = loadGeneratedSchema()
    expect(env.name).toBe('trend_analyst_output')
  })

  it('root schema is an object type', () => {
    const env = loadGeneratedSchema()
    expect(env.schema.type).toBe('object')
  })

  it('contains no $ref anywhere (OpenAI Structured Outputs rejects refs)', () => {
    const raw = readFileSync(SCHEMA_PATH, 'utf-8')
    expect(raw).not.toMatch(/"\$ref"/)
  })

  it('every object node declares additionalProperties: false', () => {
    const env = loadGeneratedSchema()
    const objectNodes = [...walkObjectNodes(env.schema)]
    expect(objectNodes.length).toBeGreaterThan(0)
    for (const node of objectNodes) {
      expect(node.additionalProperties).toBe(false)
    }
  })

  it("every object's required[] equals Object.keys(properties)", () => {
    const env = loadGeneratedSchema()
    const objectNodes = [...walkObjectNodes(env.schema)]
    for (const node of objectNodes) {
      const props = node.properties as Record<string, unknown> | undefined
      const required = node.required as string[] | undefined
      expect(props).toBeDefined()
      expect(required).toBeDefined()
      expect([...(required ?? [])].sort()).toEqual(
        Object.keys(props ?? {}).sort(),
      )
    }
  })

  it('signals array max items === 30 (TREND_SIGNALS_MAX_PER_RUN)', () => {
    const env = loadGeneratedSchema()
    const signals = (env.schema.properties as Record<string, unknown>)
      .signals as Record<string, unknown>
    expect(signals.maxItems).toBe(30)
  })
})

describe('Generated OpenAI JSON Schema — field constraints', () => {
  const getItemProp = (key: string): Record<string, unknown> => {
    const env = loadGeneratedSchema()
    const signals = (env.schema.properties as Record<string, unknown>)
      .signals as Record<string, unknown>
    const items = signals.items as Record<string, unknown>
    const props = items.properties as Record<string, Record<string, unknown>>
    const prop = props[key]
    if (!prop) {
      throw new Error(`Property ${key} not found on signal item`)
    }
    return prop
  }

  it('brand_line is nullable (accepts string or null)', () => {
    const brandLine = getItemProp('brand_line')
    // Zod 4 generates nullable as `anyOf: [{type:'string',...}, {type:'null'}]`,
    // but the spec also allows `type: ['string', 'null']`. Accept either.
    const asAnyOf = brandLine.anyOf as
      | Array<Record<string, unknown>>
      | undefined
    const asTypeArray = brandLine.type
    if (asAnyOf) {
      const types = asAnyOf
        .map((branch) => branch.type)
        .filter((t): t is string => typeof t === 'string')
      expect(types).toContain('null')
      expect(types).toContain('string')
    } else if (Array.isArray(asTypeArray)) {
      expect(asTypeArray).toContain('null')
      expect(asTypeArray).toContain('string')
    } else {
      throw new Error(
        `brand_line did not match a known nullable shape: ${JSON.stringify(brandLine)}`,
      )
    }
  })

  it('demand_score is integer with minimum 0 and maximum 100', () => {
    const demand = getItemProp('demand_score')
    expect(demand.type).toBe('integer')
    expect(demand.minimum).toBe(0)
    expect(demand.maximum).toBe(100)
  })

  it('sentiment is enum with exactly the 3 canonical values', () => {
    const sentiment = getItemProp('sentiment')
    const values = sentiment.enum as string[]
    expect([...values].sort()).toEqual(['hype_only', 'mixed', 'positive'])
  })

  it('reasoning_summary has minLength 50 and maxLength 400', () => {
    const reasoning = getItemProp('reasoning_summary')
    expect(reasoning.minLength).toBe(50)
    expect(reasoning.maxLength).toBe(400)
  })
})
