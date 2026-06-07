/**
 * Build script — generate the OpenAI Structured Outputs JSON Schema literals
 * from the Zod source contracts. Each output is versioned and consumed verbatim
 * by the corresponding n8n workflow.
 *
 * Run: npm run build:schema
 *
 * Outputs (one per TARGETS entry):
 *   - 01-trend-analyst/schemas/trend-analyst-output.schema.json (A1)
 *   - 03-site-profiler/schemas/site-recipe.schema.json          (A3)
 *
 * Post-processing applied (required for OpenAI Structured Outputs strict mode):
 *   - All object properties listed in `required[]` (no optionals).
 *   - All objects have `additionalProperties: false`.
 *   - No `format: "uri"` (Zod v4 emits it for `.url()`; OpenAI strict rejects it
 *     with HTTP 400 — see 02-sourcing-scout/schemas/README.md). Stripped here so
 *     a future `.url()` field cannot silently reintroduce the failure. No-op for
 *     the current contracts, which use no `.url()`.
 *   - No `$ref` allowed — schemas are inlined.
 */

import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { TrendAnalystOutputSchema } from '../01-trend-analyst/schemas/trend-signal.schema.js'
import { SiteRecipeSchema } from '../03-site-profiler/schemas/site-recipe.schema.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Generic recursive normalizer for OpenAI Structured Outputs requirements.
// Walks the tree, strips `format: "uri"` from every node (OpenAI strict rejects
// it), and on every node whose `type === 'object'` rewrites `required` to be
// exactly the property keys and forces `additionalProperties: false`. Other node
// shapes pass through unchanged after their children are normalized.
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
    // OpenAI Structured Outputs strict mode rejects `format: "uri"` (Zod v4
    // emits it for `.url()`). Strip it wherever it appears. No-op for contracts
    // that use no `.url()`.
    if (out.format === 'uri') {
      delete out.format
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

/** One generated artifact: a Zod source, its SO `name`, and where to write it. */
interface Target {
  readonly schema: z.ZodType
  readonly name: string
  readonly outputPath: string
}

const TARGETS: readonly Target[] = [
  {
    schema: TrendAnalystOutputSchema,
    name: 'trend_analyst_output',
    outputPath: resolve(
      __dirname,
      '..',
      '01-trend-analyst',
      'schemas',
      'trend-analyst-output.schema.json',
    ),
  },
  {
    schema: SiteRecipeSchema,
    name: 'site_recipe',
    outputPath: resolve(
      __dirname,
      '..',
      '03-site-profiler',
      'schemas',
      'site-recipe.schema.json',
    ),
  },
]

function buildEnvelope(schema: z.ZodType, name: string): OpenAIEnvelope {
  const rawSchema = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
  })

  // Verify no $ref — OpenAI Structured Outputs rejects them and Zod
  // sometimes emits them when it detects shared subschemas. If this fires
  // we need to investigate the Zod options (e.g. `io: 'output'` or per-call
  // inlining flags).
  const rawString = JSON.stringify(rawSchema)
  if (rawString.includes('"$ref"')) {
    throw new Error(
      `Generated schema "${name}" contains $ref — OpenAI Structured Outputs does not support refs. ` +
        'Investigate Zod toJSONSchema options to force inlining.',
    )
  }

  const normalized = normalizeForOpenAI(rawSchema)

  return {
    name,
    strict: true,
    schema: normalized,
  }
}

function main(): void {
  for (const target of TARGETS) {
    const wrapped = buildEnvelope(target.schema, target.name)
    const serialized = JSON.stringify(wrapped, null, 2) + '\n'
    writeFileSync(target.outputPath, serialized, 'utf-8')

    const bytes = Buffer.byteLength(serialized, 'utf-8')
    const topLevelKeys = Object.keys(wrapped).length

    console.log(`[build:schema] Wrote ${target.outputPath}`)
    console.log(
      `[build:schema] Size: ${bytes} bytes, top-level keys: ${topLevelKeys}`,
    )
  }
}

main()
