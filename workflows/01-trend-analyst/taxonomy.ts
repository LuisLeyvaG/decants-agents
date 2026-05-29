/**
 * Canonical brand taxonomy for the Trend Analyst (Agent 1).
 *
 * Single source of truth in TypeScript for the (brand, brand_line) → bucket
 * mapping. Mirrors prompts/system-prompt.md §3 (v1.0.1) — if one changes,
 * the other must change too. The .md is for the LLM (read-time); this file
 * is for the validate-and-filter function (runtime).
 *
 * Buckets:
 *   A — Editorial Core      (10 brands)  Anchors editorial voice.
 *   B — Commercial Niche    (11 brands)  Revenue sweet spot.
 *   C — Hype Volume         (7 brands)   High demand, moderate brand-fit.
 *   D — Gateway / TOFU      (9 brands)   Mass-market acquisition.
 *   E — Watch list          (19 brands)  Emerging signals, monitored.
 *   F — Excluded            (9 brands)   Clones + low-traction mass.
 *
 * Lookup is by tuple (brand, brand_line) because the same brand can map to
 * different buckets depending on the line — e.g. Chanel Bleu de Chanel
 * (mainline) is Bucket D, Chanel N°1957 (Les Exclusifs) is Bucket A.
 *
 * Resolution rules:
 *   1. Normalize brand string (trim + NFC Unicode normalization).
 *   2. Look up brand in TAXONOMY. If absent → return null (unknown brand).
 *   3. If brand_line is null → return entry.mainline (or null if brand has
 *      no mainline classification).
 *   4. If brand_line is a string → look it up in entry.lines.
 *      Return matching bucket or null.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Bucket = 'A' | 'B' | 'C' | 'D' | 'E' | 'F'

/**
 * Per-brand entry. `mainline` is the bucket for `brand_line === null`;
 * `lines` is the bucket for each named premium line.
 *
 * Both fields are optional: a brand might have only a mainline classification
 * (most Bucket A brands), only premium lines (e.g. Hermès where only
 * Hermessence is in our taxonomy and mainline is not tracked), or both
 * (Chanel, Dior, Lattafa, etc.).
 */
export interface TaxonomyEntry {
  readonly mainline?: Bucket
  readonly lines?: Readonly<Record<string, Bucket>>
}

// ---------------------------------------------------------------------------
// Canonical table — mirrors prompts/system-prompt.md §3.2-§3.4 v1.0.1
// ---------------------------------------------------------------------------

export const TAXONOMY: Readonly<Record<string, TaxonomyEntry>> = {
  // ---- Bucket A — Editorial Core (10) ----
  'Maison Francis Kurkdjian': { mainline: 'A' },
  'Le Labo': { mainline: 'A' },
  Byredo: { mainline: 'A' },
  Chanel: { mainline: 'D', lines: { 'Les Exclusifs': 'A' } },
  Hermès: { lines: { Hermessence: 'A' } },
  'Frédéric Malle': { mainline: 'A', lines: { 'Editions de Parfums': 'A' } },
  'Matière Première': { mainline: 'A' },
  Diptyque: { mainline: 'A' },
  Xinú: { mainline: 'A' },
  'Maison Margiela': { lines: { Replica: 'A' } },

  // ---- Bucket B — Commercial Niche (11) ----
  Creed: { mainline: 'B' },
  'Parfums de Marly': { mainline: 'B' },
  'Initio Parfums Privés': { mainline: 'B' },
  'Tom Ford': { lines: { 'Private Blend': 'B' } },
  'Louis Vuitton': { lines: { 'Les Parfums': 'B' } },
  Dior: { mainline: 'D', lines: { 'La Collection Privée': 'B' } },
  'Yves Saint Laurent': {
    mainline: 'D',
    lines: { 'Le Vestiaire des Parfums': 'B' },
  },
  Armani: { mainline: 'D', lines: { 'Privé': 'B' } },
  "Penhaligon's": { mainline: 'B' },
  'Acqua di Parma': { mainline: 'B', lines: { 'Signatures of the Sun': 'B' } },
  Amouage: { mainline: 'B' },

  // ---- Bucket C — Hype Volume (7) ----
  Xerjoff: { mainline: 'C' },
  'Roja Parfums': { mainline: 'C' },
  Mancera: { mainline: 'C' },
  Montale: { mainline: 'C' },
  Kilian: { mainline: 'C' },
  'Kilian Paris': { mainline: 'C' }, // alias del system prompt
  Nishane: { mainline: 'C' },
  'Stéphane Humbert Lucas': { mainline: 'C' },

  // ---- Bucket D — Gateway / TOFU (9) ----
  // Chanel, Dior, YSL, Armani: mainline ya declarado arriba en sus entradas A/B.
  'Paco Rabanne': { mainline: 'D' },
  'Carolina Herrera': { mainline: 'D' },
  Versace: { mainline: 'D' },
  Lattafa: {
    mainline: 'D',
    lines: { Pride: 'E', 'Niche Emarati': 'E' },
  },
  'Jean Paul Gaultier': { mainline: 'D' },

  // ---- Bucket E — Watch list (19) ----
  'Fueguia 1833': { mainline: 'E' },
  'House of Bō': { mainline: 'E' },
  'Ex Nihilo': { mainline: 'E' },
  Widian: { mainline: 'E' },
  'BDK Parfums': { mainline: 'E' },
  'Goldfield & Banks': { mainline: 'E' },
  'Memo Paris': { mainline: 'E' },
  'Atelier des Ors': { mainline: 'E' },
  'Profumum Roma': { mainline: 'E' },
  'Ormonde Jayne': { mainline: 'E' },
  'Arabian Oud': { mainline: 'E' },
  Rasasi: { mainline: 'E' },
  Ajmal: { mainline: 'E' },
  Sospiro: { mainline: 'E' },
  'Sospiro Perfumes': { mainline: 'E' }, // alias del system prompt
  Carthusia: { mainline: 'E' },
  Jusbox: { mainline: 'E' },
  Nasomatto: { mainline: 'E' },
  'Orto Parisi': { mainline: 'E' },
  // Lattafa Pride / Niche Emarati ya están en Lattafa.lines arriba.

  // ---- Bucket F — Excluded (9) ----
  // Clones / dupes:
  'Maison Alhambra': { mainline: 'F' },
  'Fragrance World': { mainline: 'F' },
  Dossier: { mainline: 'F' },
  'Alexandria Fragrances': { mainline: 'F' },
  // Mass market without HNW traction:
  'Calvin Klein': { mainline: 'F' },
  'Hugo Boss': { mainline: 'F' },
  'Dolce & Gabbana': { mainline: 'F' },
  Burberry: { mainline: 'F' },
  Montblanc: { mainline: 'F' },
} as const

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Apply minimal normalization for lookup:
 *   - trim surrounding whitespace
 *   - NFC-normalize so that "Hermès" composed (single char) vs decomposed
 *     (e + combining grave accent) both match a single key in TAXONOMY.
 *
 * This is intentionally minimal. Aliases like "SHL 777" → "Stéphane Humbert
 * Lucas" are NOT handled here in v1; if the LLM emits a non-canonical brand
 * string, the resulting null lookup is itself a signal to either tighten the
 * system prompt or add an alias in v2.
 */
export function normalizeBrandString(s: string): string {
  return s.trim().normalize('NFC')
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Resolve a (brand, brand_line) tuple to its canonical bucket.
 *
 * Returns null when:
 *   - brand is not in TAXONOMY (unknown brand → discovery queue).
 *   - brand is known but the requested (brand_line) shape is not declared.
 *     Example: TAXONOMY['Hermès'] has lines but no mainline; calling
 *     resolveBucket('Hermès', null) returns null because we have no
 *     classification for Hermès mainline.
 *
 * Callers distinguish these two cases by also checking isKnownBrand().
 */
export function resolveBucket(
  brand: string,
  brand_line: string | null,
): Bucket | null {
  const normalized = normalizeBrandString(brand)
  const entry = TAXONOMY[normalized]
  if (!entry) {
    return null
  }
  if (brand_line === null) {
    return entry.mainline ?? null
  }
  const lineKey = brand_line.trim()
  return entry.lines?.[lineKey] ?? null
}

/**
 * True if the brand string maps to a known entry in TAXONOMY (regardless of
 * which bucket or whether the brand_line matched). Used to differentiate
 * "unknown brand → discovery queue" from "known brand but unclassified
 * brand_line → likely a typo or new line worth flagging".
 */
export function isKnownBrand(brand: string): boolean {
  return TAXONOMY[normalizeBrandString(brand)] !== undefined
}

/**
 * True if the (brand, brand_line) tuple resolves to Bucket F (excluded).
 * Shortcut for filtering at the workflow level.
 */
export function isExcluded(brand: string, brand_line: string | null): boolean {
  return resolveBucket(brand, brand_line) === 'F'
}
