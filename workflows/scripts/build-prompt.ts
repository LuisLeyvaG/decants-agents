/**
 * Build script — resolve the Sourcing Scout (Agente 2) system prompt by
 * injecting REFERENCE_BRANDS_V3 into the `{{REFERENCE_BRANDS_V3}}` marker.
 *
 * Run: npm run build:prompt
 *
 * Reads:   02-sourcing-scout/prompts/system-prompt.md       (source, marker; READ-ONLY)
 * Imports: 02-sourcing-scout/reference-brands.ts            (REFERENCE_BRANDS_V3)
 * Writes:  02-sourcing-scout/prompts/system-prompt.generated.md  (build artifact)
 *
 * WHY A STANDALONE SCRIPT (not inline in the n8n assembly): the brand list is a
 * single source of truth (reference-brands.ts). Hand-writing it into the prompt
 * would create the two-list drift the whole v3 avoids. Rendering it here, with
 * its own test, makes the anti-drift guarantee testable in isolation.
 *
 * The resolved artifact (system-prompt.generated.md) is gitignored (*.generated.md):
 * it is 99% identical to its source, so committing both would invite editing the
 * wrong copy. The marker file is the only source of truth; the resolved file is
 * always regenerated (wired into `pretest`).
 *
 * Determinism: same input → byte-identical output. No dates, no randomness,
 * entries rendered in REFERENCE_BRANDS_V3 array order.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { REFERENCE_BRANDS_V3 } from '../02-sourcing-scout/reference-brands.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/** The single marker token the source prompt reserves for the brand list. */
export const MARKER = '{{REFERENCE_BRANDS_V3}}'

const PROMPT_DIR = resolve(
  __dirname,
  '..',
  '02-sourcing-scout',
  'prompts',
)
const SOURCE_PATH = resolve(PROMPT_DIR, 'system-prompt.md')
const GENERATED_PATH = resolve(PROMPT_DIR, 'system-prompt.generated.md')

/**
 * Render REFERENCE_BRANDS_V3 to the §3.2 markdown block: one bullet per house,
 * canonical in bold, followed by `— alias: ...` ONLY for aliases that differ
 * from the canonical (so single-alias entries like Amouage render as a bare
 * bullet). Entries are emitted in array order — deterministic, byte-stable.
 */
export function renderReferenceBrandsBlock(): string {
  return REFERENCE_BRANDS_V3.map((brand) => {
    const distinct = brand.aliases.filter((a) => a !== brand.canonical)
    const aliasSuffix =
      distinct.length > 0 ? ` — alias: ${distinct.join(', ')}` : ''
    return `- **${brand.canonical}**${aliasSuffix}`
  }).join('\n')
}

/**
 * Replace every occurrence of MARKER in `source` with the rendered brand block.
 * Pure: given the same source string (and constant), returns the same output.
 */
export function buildResolvedPrompt(source: string): string {
  const block = renderReferenceBrandsBlock()
  return source.split(MARKER).join(block)
}

function main(): void {
  const source = readFileSync(SOURCE_PATH, 'utf-8')

  if (!source.includes(MARKER)) {
    throw new Error(
      `[build:prompt] Source ${SOURCE_PATH} contains no ${MARKER} marker; ` +
        'nothing to inject. Did the marker get removed?',
    )
  }

  const resolved = buildResolvedPrompt(source)

  // Safety net: the resolved output must carry no unresolved {{...}} markers.
  const leftover = resolved.match(/\{\{[^}]*\}\}/g)
  if (leftover) {
    throw new Error(
      `[build:prompt] Resolved prompt still contains unresolved markers: ` +
        `${[...new Set(leftover)].join(', ')}. Add handling in build-prompt.ts.`,
    )
  }

  writeFileSync(GENERATED_PATH, resolved, 'utf-8')

  const bytes = Buffer.byteLength(resolved, 'utf-8')
  console.log(`[build:prompt] Wrote ${GENERATED_PATH}`)
  console.log(
    `[build:prompt] Injected ${REFERENCE_BRANDS_V3.length} reference brands, ` +
      `${bytes} bytes.`,
  )
}

// Run the IO only when executed directly (npm run build:prompt), not when the
// pure functions are imported by the test — keeps importing this module
// side-effect-free.
const invokedDirectly =
  import.meta.url === pathToFileURL(process.argv[1] ?? '').href
if (invokedDirectly) {
  main()
}
