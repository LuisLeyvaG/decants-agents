/**
 * Reference premium brands for the Sourcing Scout (Agente 2) — v3.
 *
 * Single source of truth in TypeScript for the curated list of niche / premium
 * houses whose presence in a provider's catalog is a POSITIVE signal of premium
 * fit. Mirrors prompts/system-prompt.md §3 (v3.0.0) — if one changes, the other
 * must change too. The .md is for the LLM (read-time, injected at build-time);
 * this file is the runtime constant any future Code node / heuristic can import.
 *
 * HOW THIS DIFFERS FROM AGENTE 1's taxonomy.ts
 * --------------------------------------------------------------------------
 * Agente 1's TAXONOMY is an ALLOW-LIST: it defines the universe of brands the
 * Trend Analyst is permitted to emit, and lookups partition signals into
 * buckets (known / unknown / excluded).
 *
 * REFERENCE_BRANDS_V3 is NOT an allow-list and does NOT restrict which stores
 * Agente 2 may admit. It is a GRADED FIT SIGNAL: detecting these houses in a
 * provider's catalog RAISES that provider's trust_quality. A legitimate decants
 * store that happens to carry none of them is still fully admissible — the gate
 * is "own functional website with a visible catalog" (see system-prompt §5.1),
 * not "carries a reference brand".
 *
 * CURATION PRINCIPLE (v3)
 * --------------------------------------------------------------------------
 * The list is deliberately pruned toward the hard-niche / limited-distribution
 * end: anchors that "a casual reseller does not touch". High-volume,
 * marketplace-saturated niche (e.g. Mancera / Montale) is intentionally EXCLUDED
 * because its ubiquity would dilute the signal — a dropshipper carries it too.
 *
 * PRIVATE LINES ARE ENCODED IN `canonical`, NOT THE BARE HOUSE
 * --------------------------------------------------------------------------
 * For houses whose mass-market mainline is casual but whose private/exclusive
 * line is the premium signal, the `canonical` names the LINE ("Dior — La
 * Collection Privée"), never the bare house ("Dior"). Rationale: if the
 * canonical were just "Dior", detecting Sauvage in a catalog would wrongly score
 * premium fit — the opposite of what this list is for. The private line IS the
 * signal; the mainline is not. The `aliases` capture line variants so matching
 * still engages, but they NEVER include the bare house name on its own.
 *
 * Matching against catalog text is intended to be case/diacritic/punctuation-
 * insensitive (cf. the legacy normalizeBrandToken in legacy/scripts/scoring.ts,
 * archived — do not reactivate). Each entry carries the aliases a catalog might
 * surface.
 */

export interface ReferenceBrand {
  /**
   * Canonical display name. For private-line houses this names the LINE
   * (e.g. "Tom Ford Private Blend"), never the bare house, by design.
   */
  readonly canonical: string
  /**
   * Surface variants a catalog might use. Case/diacritic/punctuation-insensitive
   * matching is assumed. For private-line entries these capture line variants
   * ("Privée", "Collection Privée") but MUST NOT include the bare house name
   * alone — that would defeat the line-specificity the canonical encodes.
   */
  readonly aliases: ReadonlyArray<string>
}

/**
 * The curated reference list. ~30 houses, pruned toward hard niche + selective
 * private lines. Versioned in the name (V3) on purpose: single source of truth,
 * diffeable. Injected into the system prompt at build-time — never typed by hand
 * into the prompt string.
 */
export const REFERENCE_BRANDS_V3: ReadonlyArray<ReferenceBrand> = [
  // ---- Hard niche — presence is a strong fit signal ----
  { canonical: 'Amouage', aliases: ['Amouage'] },
  {
    canonical: 'Maison Francis Kurkdjian',
    aliases: ['MFK', 'Maison Francis Kurkdjian', 'Francis Kurkdjian'],
  },
  { canonical: 'Xerjoff', aliases: ['Xerjoff'] },
  { canonical: 'Roja Parfums', aliases: ['Roja Parfums', 'Roja', 'Roja Dove'] },
  {
    canonical: 'Parfums de Marly',
    aliases: ['Parfums de Marly', 'PdM', 'Marly'],
  },
  {
    canonical: 'Initio Parfums Privés',
    aliases: ['Initio Parfums Privés', 'Initio Parfums Prives', 'Initio'],
  },
  { canonical: 'Nishane', aliases: ['Nishane'] },
  { canonical: 'BDK Parfums', aliases: ['BDK Parfums', 'BDK'] },
  { canonical: 'Le Labo', aliases: ['Le Labo'] },
  { canonical: 'Creed', aliases: ['Creed'] },
  {
    canonical: 'Frédéric Malle',
    aliases: ['Frédéric Malle', 'Frederic Malle', 'Editions de Parfums'],
  },
  { canonical: 'Byredo', aliases: ['Byredo'] },
  { canonical: 'Diptyque', aliases: ['Diptyque'] },
  { canonical: 'Memo Paris', aliases: ['Memo Paris', 'Memo'] },
  { canonical: 'Nasomatto', aliases: ['Nasomatto'] },
  { canonical: 'Orto Parisi', aliases: ['Orto Parisi'] },
  { canonical: 'Ex Nihilo', aliases: ['Ex Nihilo'] },
  {
    canonical: 'Stéphane Humbert Lucas 777',
    aliases: [
      'Stéphane Humbert Lucas 777',
      'Stephane Humbert Lucas 777',
      'SHL 777',
      'SHL',
    ],
  },
  { canonical: 'Fueguia 1833', aliases: ['Fueguia 1833', 'Fueguia'] },
  { canonical: 'Ormonde Jayne', aliases: ['Ormonde Jayne'] },
  { canonical: 'Tiziana Terenzi', aliases: ['Tiziana Terenzi', 'Terenzi'] },
  { canonical: 'Maison Crivelli', aliases: ['Maison Crivelli', 'Crivelli'] },

  // ---- Selective private / exclusive lines ----
  // canonical names the LINE, not the bare house; aliases never include the
  // bare house name on its own (see file docblock).
  {
    canonical: 'Armani Privé',
    aliases: ['Armani Privé', 'Armani Prive', 'Giorgio Armani Privé'],
  },
  {
    canonical: 'Tom Ford Private Blend',
    aliases: ['Tom Ford Private Blend', 'TF Private Blend', 'Private Blend'],
  },
  {
    canonical: 'Dior — La Collection Privée',
    aliases: [
      'La Collection Privée',
      'Collection Privée',
      'Dior Privée',
      'Maison Christian Dior',
    ],
  },
  {
    canonical: "Guerlain — L'Art & la Matière",
    aliases: [
      "L'Art & la Matière",
      "L'Art et la Matière",
      'Art et la Matiere',
      'Guerlain Exclusives',
    ],
  },
  {
    canonical: 'Chanel — Les Exclusifs',
    aliases: ['Les Exclusifs de Chanel', 'Les Exclusifs'],
  },
  { canonical: 'Hermès — Hermessence', aliases: ['Hermessence'] },
  {
    canonical: 'Louis Vuitton — Les Parfums',
    aliases: ['Louis Vuitton Les Parfums', 'LV Les Parfums'],
  },
  {
    canonical: 'Yves Saint Laurent — Le Vestiaire des Parfums',
    aliases: ['Le Vestiaire des Parfums', 'YSL Le Vestiaire'],
  },
] as const
