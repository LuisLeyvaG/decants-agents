/**
 * Sprint 3 — ONE-SHOT Instagram JSON inspector. DISK-ONLY, ZERO network.
 * NOT part of `npm test`. NOT the IG parser (that is 3.3).
 *
 *   node --import tsx 02-sourcing-scout/scripts/ig-inspect-json.ts
 *   # (from the `workflows/` directory)
 *
 * Reads the HTML already dumped by ig-diagnose.ts (tmp/ig-sample-hashtag.html,
 * tmp/ig-sample-profile.html), extracts every <script type="application/json">
 * block, and answers ONE question: are the provider data (handles / names /
 * bios / posts / contact) sitting in that embedded JSON, parseable WITHOUT
 * running JS — or is the HTML just SPA config and the real data arrives via a
 * second GraphQL/internal-API request the initial HTML never carries?
 *
 * For each file it prints:
 *   1. a one-line summary of every application/json block (size, attrs, shape),
 *   2. a depth-2 structure map of the LARGEST block,
 *   3. a provider-signal hunt over ALL blocks' JSON text (key/value markers +
 *      a short trimmed example window — NO mass dump of personal data).
 */

import { readFileSync } from 'node:fs'

const TMP_DIR = new URL('../tmp/', import.meta.url) // 02-sourcing-scout/tmp/
const FILES = ['ig-sample-hashtag.html', 'ig-sample-profile.html']

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

interface JsonBlock {
  readonly index: number
  readonly attrs: string
  readonly raw: string
  readonly len: number
}

/** Pull every <script type="application/json" ...>…</script> block. */
function extractJsonBlocks(html: string): JsonBlock[] {
  const re = /<script\b([^>]*\btype=["']application\/json["'][^>]*)>([\s\S]*?)<\/script>/gi
  const out: JsonBlock[] = []
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(html)) !== null) {
    const raw = m[2] ?? ''
    out.push({ index: i++, attrs: (m[1] ?? '').trim(), raw, len: raw.length })
  }
  return out
}

// ---------------------------------------------------------------------------
// Structure mapping (orientation only — bounded output)
// ---------------------------------------------------------------------------

function shapeOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return `Array(${v.length})`
  if (typeof v === 'object') return `object{${Object.keys(v as object).length}}`
  if (typeof v === 'string') return `string(${(v as string).length})`
  return typeof v
}

/** Depth-limited key map. Caps keys-per-level so a huge blob can't flood stdout. */
function mapStructure(value: unknown, depth = 0, maxDepth = 2, keyCap = 30): string[] {
  const pad = '  '.repeat(depth)
  const lines: string[] = []
  if (Array.isArray(value)) {
    lines.push(`${pad}Array(${value.length})`)
    if (depth < maxDepth && value.length > 0) lines.push(...mapStructure(value[0], depth + 1, maxDepth, keyCap))
    return lines
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
    for (const k of keys.slice(0, keyCap)) {
      const v = obj[k]
      lines.push(`${pad}${k}: ${shapeOf(v)}`)
      if (depth < maxDepth && v && typeof v === 'object') lines.push(...mapStructure(v, depth + 1, maxDepth, keyCap))
    }
    if (keys.length > keyCap) lines.push(`${pad}… (+${keys.length - keyCap} more keys)`)
    return lines
  }
  lines.push(`${pad}${shapeOf(value)}`)
  return lines
}

// ---------------------------------------------------------------------------
// Provider-signal hunt
// ---------------------------------------------------------------------------

/**
 * Markers that, if present in the embedded JSON, mean the provider data is in
 * the initial HTML and parseable without JS. Mix of classic IG GraphQL keys,
 * modern (data-sjs / xdt) keys, and the contact fields that matter most for
 * sourcing (phone / email / external link / category).
 */
const SIGNALS: readonly string[] = [
  // identity / profile
  'username',
  'full_name',
  'biography',
  'profile_pic_url',
  'external_url',
  'category_name',
  'is_business_account',
  // contact (gold for sourcing)
  'contact_phone_number',
  'public_phone_number',
  'business_phone_number',
  'business_email',
  'public_email',
  'whatsapp',
  // posts / media
  'edge_owner_to_timeline_media',
  'edge_hashtag_to_media',
  'shortcode',
  'caption',
  'GraphImage',
  // counts
  'edge_followed_by',
  'follower_count',
  // page-type / modern envelope markers
  'ProfilePage',
  'PostPage',
  'TagPage',
  'PolarisProfilePage',
  'xdt_api__v1',
  'RelayPrefetchedStreamCache',
  '__bbox',
]

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  return haystack.split(needle).length - 1
}

/** First occurrence window, whitespace-collapsed, trimmed to ~220 chars. NO mass dump. */
function firstWindow(haystack: string, needle: string, around = 200): string | null {
  const i = haystack.indexOf(needle)
  if (i === -1) return null
  const start = Math.max(0, i - 20)
  return haystack.slice(start, i + around).replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// Per-file report
// ---------------------------------------------------------------------------

function inspectFile(filename: string): void {
  let html: string
  try {
    html = readFileSync(new URL(filename, TMP_DIR), 'utf8')
  } catch (e) {
    console.error(`\n!! could not read ${filename}: ${(e as Error).message}`)
    return
  }

  const blocks = extractJsonBlocks(html)
  console.log(`\n############################################################`)
  console.log(`# ${filename} — ${html.length} chars, ${blocks.length} application/json block(s)`)
  console.log(`############################################################`)

  // 1. one line per block
  console.log('\n-- blocks (index | bytes | parseable | top-level shape | attrs) --')
  let parseableCount = 0
  const parsed: Array<{ block: JsonBlock; value: unknown }> = []
  for (const b of blocks) {
    let shape = '(unparsed)'
    let ok = false
    try {
      const v = JSON.parse(b.raw)
      ok = true
      parseableCount++
      shape = shapeOf(v)
      parsed.push({ block: b, value: v })
    } catch (e) {
      shape = `PARSE ERROR: ${(e as Error).message.slice(0, 60)}`
    }
    console.log(
      `   [${String(b.index).padStart(2)}] ${String(b.len).padStart(7)}B ${ok ? 'ok ' : 'ERR'} ${shape.padEnd(16)} ${b.attrs.slice(0, 70)}`,
    )
  }
  console.log(`   (${parseableCount}/${blocks.length} parsed cleanly)`)

  // 2. structure map of the largest block
  const largest = [...blocks].sort((a, b) => b.len - a.len)[0]
  if (largest) {
    console.log(`\n-- largest block [#${largest.index}] (${largest.len}B) — depth-2 structure map --`)
    const p = parsed.find((x) => x.block.index === largest.index)
    if (p) {
      for (const line of mapStructure(p.value, 0, 2)) console.log(`   ${line}`)
    } else {
      console.log('   (did not parse as JSON; showing first 300 raw chars)')
      console.log(`   ${largest.raw.slice(0, 300).replace(/\s+/g, ' ')}`)
    }
  }

  // 3. provider-signal hunt over ALL blocks' JSON text combined
  const allJson = blocks.map((b) => b.raw).join('\n')
  console.log(`\n-- provider-signal hunt (across all ${blocks.length} JSON blocks) --`)
  let anyHit = false
  for (const sig of SIGNALS) {
    const c = countOccurrences(allJson, sig)
    if (c === 0) continue
    anyHit = true
    const win = firstWindow(allJson, sig)
    console.log(`   ${sig.padEnd(28)} ×${String(c).padStart(4)}  e.g. …${(win ?? '').slice(0, 200)}…`)
  }
  if (!anyHit) console.log('   (no provider signals found in any JSON block)')
}

// ---------------------------------------------------------------------------

function main(): void {
  const targets = process.argv.slice(2)
  const files = targets.length > 0 ? targets : FILES
  console.log(`[ig-inspect] reading ${files.length} file(s) from ${TMP_DIR.pathname} — DISK ONLY, no network`)
  for (const f of files) inspectFile(f)
  console.log('\n[ig-inspect] done. Signals present ⇒ data is in the initial HTML JSON (parseable without JS).')
}

main()
