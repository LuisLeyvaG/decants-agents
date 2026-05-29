/**
 * Unit tests for the canonical brand taxonomy.
 *
 * These tests are the runtime contract that mirrors the system prompt v1.0.1
 * §3.2-§3.4. If the prompt changes the brand lists, this file must be the
 * place where the diff lands first — any drift between TAXONOMY and the
 * prompt is a contract bug.
 *
 * Bucket counts (per system prompt v1.0.1 §3, materialized in TAXONOMY):
 *   A = 10  B = 11  C = 7  D = 9  E = 19  F = 9
 *
 *   Note on F: the prompt §3.4 paraphrases "Lattafa sub-brands that clone"
 *   as a 5th conceptual clone category, but it has no canonical brand_string
 *   so it is not materialized in TAXONOMY. Hence 4 clones + 5 mass = 9.
 *
 * Notes on counting in TAXONOMY entries:
 *   - Aliases (e.g. "Kilian Paris" alongside "Kilian", "Sospiro Perfumes"
 *     alongside "Sospiro") add +1 to the entry count for their bucket vs the
 *     prompt-listed brand count. Tests below account for these explicitly.
 *   - Brands with no `mainline` (Hermès, Maison Margiela, Tom Ford, Louis
 *     Vuitton) contribute 0 to `mainline === X` counts but still resolve to
 *     a bucket via their `lines`.
 */

import {
  TAXONOMY,
  isExcluded,
  isKnownBrand,
  resolveBucket,
  type Bucket,
} from '../taxonomy.js'

// Helper: count distinct brand keys that resolve to a given bucket via either
// mainline (when null brand_line) OR ANY of their declared lines.
const distinctBrandsResolvingTo = (bucket: Bucket): number => {
  let count = 0
  for (const entry of Object.values(TAXONOMY)) {
    if (entry.mainline === bucket) {
      count += 1
      continue
    }
    if (entry.lines && Object.values(entry.lines).includes(bucket)) {
      count += 1
    }
  }
  return count
}

const countMainline = (bucket: Bucket): number => {
  return Object.values(TAXONOMY).filter((e) => e.mainline === bucket).length
}

// 'è' as decomposed sequence: 'e' (U+0065) + COMBINING GRAVE ACCENT (U+0300).
const HERMES_DECOMPOSED = 'Herm' + 'è' + 's'
// 'è' as precomposed single codepoint U+00E8.
const HERMES_COMPOSED = 'Hermès'

describe('TAXONOMY const integrity', () => {
  it('Bucket A: exactly 10 distinct brand entries resolve to A (mainline or any line)', () => {
    // The prompt lists 10 Bucket A brands; some have mainline=A directly
    // (MFK, Le Labo, Byredo, Frédéric Malle, Matière Première, Diptyque,
    // Xinú = 7), others reach A only via a premium line (Chanel→Les
    // Exclusifs, Hermès→Hermessence, Maison Margiela→Replica = 3).
    expect(distinctBrandsResolvingTo('A')).toBe(10)
  })

  it('Bucket B: exactly 11 distinct brand entries resolve to B', () => {
    expect(distinctBrandsResolvingTo('B')).toBe(11)
  })

  it('Bucket C: exactly 8 entries with mainline = C (7 prompt-listed brands + 1 alias "Kilian Paris")', () => {
    // The prompt lists 7 brands. TAXONOMY adds the "Kilian Paris" alias as a
    // separate key per the system prompt §3.2 ("also valid: `Kilian Paris`
    // in `brand`") so we expect 8 mainline-C entries. Same pattern as
    // "Sospiro Perfumes" alias in Bucket E.
    expect(countMainline('C')).toBe(8)
  })

  it('Bucket D: exactly 9 distinct brand entries resolve to D (mainline or any line)', () => {
    // Includes Chanel, Dior, YSL, Armani (whose mainline is D but whose
    // premium lines route elsewhere), plus Paco Rabanne, Carolina Herrera,
    // Versace, Lattafa, Jean Paul Gaultier.
    expect(distinctBrandsResolvingTo('D')).toBe(9)
  })

  it('Bucket E: exactly 19 entries with mainline = E (includes "Sospiro Perfumes" alias; excludes Lattafa Pride/Niche which live in Lattafa.lines)', () => {
    expect(countMainline('E')).toBe(19)
  })

  it('Bucket F: exactly 9 entries with mainline = F', () => {
    // 4 clone brands + 5 mass market = 9 mainline-F entries in TAXONOMY.
    expect(countMainline('F')).toBe(9)
  })

  it('Bucket F: all 4 declared clone brands resolve to F', () => {
    const clones = [
      'Maison Alhambra',
      'Fragrance World',
      'Dossier',
      'Alexandria Fragrances',
    ]
    for (const clone of clones) {
      expect(resolveBucket(clone, null)).toBe('F')
    }
  })
})

describe('resolveBucket — happy path', () => {
  it('resolves (MFK, null) to A', () => {
    expect(resolveBucket('Maison Francis Kurkdjian', null)).toBe('A')
  })

  it('resolves (Chanel, "Les Exclusifs") to A (premium line)', () => {
    expect(resolveBucket('Chanel', 'Les Exclusifs')).toBe('A')
  })

  it('resolves (Chanel, null) to D (mainline)', () => {
    expect(resolveBucket('Chanel', null)).toBe('D')
  })

  it('resolves (Dior, "La Collection Privée") to B', () => {
    expect(resolveBucket('Dior', 'La Collection Privée')).toBe('B')
  })

  it('resolves (Dior, null) to D (mainline)', () => {
    expect(resolveBucket('Dior', null)).toBe('D')
  })

  it('resolves (Tom Ford, "Private Blend") to B', () => {
    expect(resolveBucket('Tom Ford', 'Private Blend')).toBe('B')
  })

  it('resolves (Hermès, "Hermessence") to A', () => {
    expect(resolveBucket('Hermès', 'Hermessence')).toBe('A')
  })

  it('resolves (Lattafa, null) to D (mainline — Khamrah, Asad, Yara)', () => {
    expect(resolveBucket('Lattafa', null)).toBe('D')
  })

  it('resolves (Lattafa, "Pride") to E (premium line)', () => {
    expect(resolveBucket('Lattafa', 'Pride')).toBe('E')
  })

  it('resolves (Lattafa, "Niche Emarati") to E', () => {
    expect(resolveBucket('Lattafa', 'Niche Emarati')).toBe('E')
  })
})

describe('resolveBucket — unknown / unmapped', () => {
  it('resolves (unknown brand, null) to null', () => {
    expect(resolveBucket('Some Unknown Brand', null)).toBeNull()
  })

  it('resolves (unknown brand, "Any Line") to null', () => {
    expect(resolveBucket('Some Unknown Brand', 'Any Line')).toBeNull()
  })

  it('resolves (Hermès, null) to null — Hermès has lines but no mainline declared', () => {
    expect(resolveBucket('Hermès', null)).toBeNull()
  })

  it('resolves (Chanel, "Nonexistent Line") to null — known brand, unknown line', () => {
    expect(resolveBucket('Chanel', 'Nonexistent Line')).toBeNull()
  })
})

describe('resolveBucket — normalization', () => {
  it('trims surrounding whitespace on brand', () => {
    expect(resolveBucket('  Maison Francis Kurkdjian  ', null)).toBe('A')
  })

  it('matches NFD-decomposed against NFC-composed brand keys (Hermès)', () => {
    // Sanity: the two strings ARE byte-different before normalization.
    expect(HERMES_DECOMPOSED).not.toBe(HERMES_COMPOSED)
    expect(HERMES_DECOMPOSED.length).toBe(7) // H e r m e ◌̀ s
    expect(HERMES_COMPOSED.length).toBe(6) //   H e r m è s
    // Both should resolve identically after the function's internal NFC.
    expect(resolveBucket(HERMES_DECOMPOSED, 'Hermessence')).toBe(
      resolveBucket(HERMES_COMPOSED, 'Hermessence'),
    )
    expect(resolveBucket(HERMES_DECOMPOSED, 'Hermessence')).toBe('A')
  })
})

describe('isKnownBrand', () => {
  it('returns true for a brand in TAXONOMY', () => {
    expect(isKnownBrand('Creed')).toBe(true)
  })

  it('returns false for a brand not in TAXONOMY', () => {
    expect(isKnownBrand('BrandXYZ')).toBe(false)
  })
})

describe('isExcluded', () => {
  it('returns true for a clone brand (Maison Alhambra)', () => {
    expect(isExcluded('Maison Alhambra', null)).toBe(true)
  })

  it('returns false for an editorial brand (MFK)', () => {
    expect(isExcluded('Maison Francis Kurkdjian', null)).toBe(false)
  })

  it('returns true for a mass-market excluded brand (Calvin Klein)', () => {
    expect(isExcluded('Calvin Klein', null)).toBe(true)
  })
})
