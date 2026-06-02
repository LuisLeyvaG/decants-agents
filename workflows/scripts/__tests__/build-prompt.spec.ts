/**
 * Tests for the Sourcing Scout prompt build (build-prompt.ts).
 *
 * The pure-function tests need no build step. The "generated artifact" test
 * reads system-prompt.generated.md, which requires:
 *
 *   npm run build:prompt
 *
 * to have run first. The `pretest` hook in package.json automates this — CI
 * runs `npm test` and the prompt is regenerated automatically.
 *
 * This is the anti-drift net: the rendered block is derived from
 * REFERENCE_BRANDS_V3, never hand-typed, and these assertions trip if the
 * render logic breaks (unresolved markers, a missing brand, non-determinism).
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MARKER,
  buildResolvedPrompt,
  renderReferenceBrandsBlock,
} from '../build-prompt.js'
import { REFERENCE_BRANDS_V3 } from '../../02-sourcing-scout/reference-brands.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const PROMPT_DIR = resolve(
  __dirname,
  '..',
  '..',
  '02-sourcing-scout',
  'prompts',
)
const SOURCE_PATH = resolve(PROMPT_DIR, 'system-prompt.md')
const GENERATED_PATH = resolve(PROMPT_DIR, 'system-prompt.generated.md')

const readSource = (): string => readFileSync(SOURCE_PATH, 'utf-8')
const readGenerated = (): string => readFileSync(GENERATED_PATH, 'utf-8')

// Matches any {{...}} marker token.
const ANY_MARKER = /\{\{[^}]*\}\}/g

describe('renderReferenceBrandsBlock — format', () => {
  it('renders one bullet per reference brand', () => {
    const lines = renderReferenceBrandsBlock().split('\n')
    expect(lines).toHaveLength(REFERENCE_BRANDS_V3.length)
    for (const line of lines) {
      expect(line.startsWith('- **')).toBe(true)
    }
  })

  it('renders a single-alias entry as a bare bullet (no "— alias:")', () => {
    const block = renderReferenceBrandsBlock()
    // Amouage: aliases === ['Amouage'] → no distinct aliases → bare bullet.
    expect(block).toContain('- **Amouage**')
    expect(block).not.toMatch(/- \*\*Amouage\*\* — alias:/)
  })

  it('renders distinct aliases after "— alias:", excluding the canonical', () => {
    const block = renderReferenceBrandsBlock()
    expect(block).toContain(
      '- **Maison Francis Kurkdjian** — alias: MFK, Francis Kurkdjian',
    )
    // The canonical itself must not appear inside its own alias list.
    expect(block).not.toContain(
      'alias: MFK, Maison Francis Kurkdjian, Francis Kurkdjian',
    )
  })

  it('preserves a private-line canonical verbatim (line is the signal)', () => {
    const block = renderReferenceBrandsBlock()
    expect(block).toContain('- **Dior — La Collection Privée** — alias:')
    expect(block).toContain('- **Tom Ford Private Blend** — alias:')
  })
})

describe('source prompt integrity', () => {
  it('contains exactly one REFERENCE_BRANDS_V3 marker', () => {
    const occurrences = readSource().split(MARKER).length - 1
    expect(occurrences).toBe(1)
  })

  it('contains no other {{...}} marker than the contemplated one', () => {
    const markers = readSource().match(ANY_MARKER) ?? []
    // Every marker present must be the one we know how to resolve.
    const unexpected = markers.filter((m) => m !== MARKER)
    expect(unexpected).toEqual([])
  })
})

describe('buildResolvedPrompt — output', () => {
  const resolved = (): string => buildResolvedPrompt(readSource())

  it('leaves no unresolved {{...}} markers', () => {
    expect(resolved().match(ANY_MARKER)).toBeNull()
  })

  it('removes the REFERENCE_BRANDS_V3 marker', () => {
    expect(resolved().includes(MARKER)).toBe(false)
  })

  it('contains every canonical brand name', () => {
    const out = resolved()
    for (const brand of REFERENCE_BRANDS_V3) {
      expect(out).toContain(brand.canonical)
    }
  })

  it('contains every alias', () => {
    const out = resolved()
    for (const brand of REFERENCE_BRANDS_V3) {
      for (const alias of brand.aliases) {
        expect(out).toContain(alias)
      }
    }
  })
})

describe('determinism', () => {
  it('renderReferenceBrandsBlock is byte-identical across calls', () => {
    expect(renderReferenceBrandsBlock()).toBe(renderReferenceBrandsBlock())
  })

  it('buildResolvedPrompt is byte-identical across calls', () => {
    const src = readSource()
    expect(buildResolvedPrompt(src)).toBe(buildResolvedPrompt(src))
  })
})

describe('generated artifact (requires `npm run build:prompt` / pretest)', () => {
  it('matches a fresh render of the source (no stale drift)', () => {
    expect(readGenerated()).toBe(buildResolvedPrompt(readSource()))
  })
})
