/**
 * Build script — generate the OpenAI Structured Outputs JSON Schema literal
 * from the Zod TrendAnalystOutputSchema. The output is versioned and consumed
 * verbatim by the n8n workflow (sub-step 5.3.6).
 *
 * Run: npm run build:schema
 *
 * Output: 01-trend-analyst/schemas/trend-analyst-output.schema.json
 *
 * Post-processing applied (required for OpenAI Structured Outputs strict mode):
 *   - All object properties listed in `required[]` (no optionals).
 *   - All objects have `additionalProperties: false`.
 *   - No `$ref` allowed — schemas are inlined.
 */

import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { TrendAnalystOutputSchema } from '../01-trend-analyst/schemas/trend-signal.schema.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Generic recursive normalizer for OpenAI Structured Outputs requirements.
// Walks the tree, and on every node whose `type === 'object'` rewrites
// `required` to be exactly the property keys and forces
// `additionalProperties: false`. Other node shapes pass through unchanged
// after their children are normalized.
function normalizeForOpenAI(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(normalizeForOpenAI)
  }
  if (node !== null && typeof node === 'object') {
    const obj = node as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      out[k] = normalizeForOpenAI(v)
    }
    if (
      out.type === 'object' &&
      out.properties &&
      typeof out.properties === 'object' &&
      !Array.isArray(out.properties)
    ) {
      const propsKeys = Object.keys(out.properties as Record<string, unknown>)
      out.required = propsKeys
      out.additionalProperties = false
    }
    return out
  }
  return node
}

interface OpenAIEnvelope {
  readonly name: string
  readonly strict: true
  readonly schema: unknown
}

function buildSchema(): OpenAIEnvelope {
  const rawSchema = z.toJSONSchema(TrendAnalystOutputSchema, {
    target: 'draft-2020-12',
  })

  // Verify no $ref — OpenAI Structured Outputs rejects them and Zod
  // sometimes emits them when it detects shared subschemas. If this fires
  // we need to investigate the Zod options (e.g. `io: 'output'` or per-call
  // inlining flags).
  const rawString = JSON.stringify(rawSchema)
  if (rawString.includes('"$ref"')) {
    throw new Error(
      'Generated schema contains $ref — OpenAI Structured Outputs does not support refs. ' +
        'Investigate Zod toJSONSchema options to force inlining.',
    )
  }

  const normalized = normalizeForOpenAI(rawSchema)

  return {
    name: 'trend_analyst_output',
    strict: true,
    schema: normalized,
  }
}

function main(): void {
  const wrapped = buildSchema()
  const outputPath = resolve(
    __dirname,
    '..',
    '01-trend-analyst',
    'schemas',
    'trend-analyst-output.schema.json',
  )
  const serialized = JSON.stringify(wrapped, null, 2) + '\n'
  writeFileSync(outputPath, serialized, 'utf-8')

  const bytes = Buffer.byteLength(serialized, 'utf-8')
  const topLevelKeys = Object.keys(wrapped).length

  console.log(`[build:schema] Wrote ${outputPath}`)
  console.log(
    `[build:schema] Size: ${bytes} bytes, top-level keys: ${topLevelKeys}`,
  )
}

main()
