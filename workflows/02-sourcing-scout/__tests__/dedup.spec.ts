/**
 * Unit tests for computeDedupHash + its normalization helpers.
 *
 * The contract: the same provider, however its phone / handle is formatted
 * across sources, must collapse to one hash; a provider with no identifier at
 * all must throw.
 */

import {
  computeDedupHash,
  normalizeDomain,
  normalizeHandle,
  normalizePhone,
} from '../scripts/dedup.js'

describe('normalizePhone', () => {
  it('strips +52, spaces, dashes and parentheses to a 10-digit number', () => {
    expect(normalizePhone('+52 (55) 1234-5678')).toBe('5512345678')
  })

  it('strips a bare 52 country prefix', () => {
    expect(normalizePhone('525512345678')).toBe('5512345678')
  })

  it('leaves a plain 10-digit national number untouched', () => {
    expect(normalizePhone('5512345678')).toBe('5512345678')
  })

  it('does not strip "52" from a 10-digit number that merely starts with it', () => {
    // "52" here is the area/prefix of a genuine 10-digit number, not a country code.
    expect(normalizePhone('5212345678')).toBe('5212345678')
  })

  it('strips the "1" mobile marker after the country code (+52 1 ...)', () => {
    expect(normalizePhone('+52 1 55 1234 5678')).toBe('5512345678')
  })

  it.each([
    ['+52 1 55 1234 5678'], // country code + mobile "1"
    ['+52 55 1234 5678'], // country code, no "1"
    ['55 1234 5678'], // bare national
  ])('normalizes %s to the canonical 10-digit form', (input) => {
    expect(normalizePhone(input)).toBe('5512345678')
  })
})

describe('normalizeHandle', () => {
  it('lowercases, trims and drops the leading @', () => {
    expect(normalizeHandle('  @LeyvaScents ')).toBe('leyvascents')
  })

  it('treats @handle and handle identically', () => {
    expect(normalizeHandle('@leyvascents')).toBe(normalizeHandle('leyvascents'))
  })
})

describe('normalizeDomain', () => {
  it.each([
    ['https://leyvascents.mx', 'leyvascents.mx'],
    ['http://leyvascents.mx', 'leyvascents.mx'],
    ['https://www.leyvascents.mx', 'leyvascents.mx'],
    ['http://www.leyvascents.mx/', 'leyvascents.mx'],
    ['https://www.leyvascents.mx/catalog?page=2', 'leyvascents.mx'],
    ['leyvascents.mx/catalog', 'leyvascents.mx'],
    ['HTTPS://WWW.LeyvaScents.MX/Catalog', 'leyvascents.mx'],
    ['https://leyvascents.mx:8443/catalog', 'leyvascents.mx'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected)
  })

  it('collapses http/https, www and trailing-slash variants to one domain', () => {
    const variants = [
      'https://leyvascents.mx',
      'http://www.leyvascents.mx/',
      'https://www.leyvascents.mx/catalog',
    ].map(normalizeDomain)
    expect(new Set(variants).size).toBe(1)
  })

  it('returns "" for an empty string', () => {
    expect(normalizeDomain('')).toBe('')
    expect(normalizeDomain('   ')).toBe('')
  })
})

describe('computeDedupHash', () => {
  it('produces the same hash for +52 and non-+52 forms of the same number', () => {
    const a = computeDedupHash('+52 55 1234 5678', null)
    const b = computeDedupHash('5512345678', null)
    expect(a).toBe(b)
  })

  it('produces the same hash across +52-1, +52 and bare forms of the same cell', () => {
    const hashes = ['+52 1 55 1234 5678', '+52 55 1234 5678', '55 1234 5678'].map((p) =>
      computeDedupHash(p, null),
    )
    expect(new Set(hashes).size).toBe(1)
  })

  it('keys on the phone: same number with vs. without an IG handle → same hash', () => {
    // The phone is the strongest identifier, so the handle does not change the key.
    const withHandle = computeDedupHash('5512345678', '@leyvascents')
    const withoutHandle = computeDedupHash('5512345678', null)
    expect(withHandle).toBe(withoutHandle)
  })

  it('falls back to the handle only when there is no phone', () => {
    const phoneKeyed = computeDedupHash('5512345678', 'leyvascents')
    const handleKeyed = computeDedupHash(null, 'leyvascents')
    // Different key namespaces ("tel:" vs "ig:") → different hashes.
    expect(phoneKeyed).not.toBe(handleKeyed)
  })

  it('produces the same hash for @handle and handle', () => {
    const a = computeDedupHash(null, '@leyvascents')
    const b = computeDedupHash(null, 'leyvascents')
    expect(a).toBe(b)
  })

  it('produces a stable hex sha256 (64 chars)', () => {
    expect(computeDedupHash('5512345678', 'leyvascents')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('distinguishes different providers', () => {
    expect(computeDedupHash('5512345678', null)).not.toBe(computeDedupHash('5599999999', null))
  })

  it('throws when both identifiers are null (and no catalog URL)', () => {
    expect(() => computeDedupHash(null, null)).toThrow(/cannot deduplicate/i)
  })

  it('throws when both identifiers normalize to empty (and no catalog URL)', () => {
    expect(() => computeDedupHash('---', '@')).toThrow(/cannot deduplicate/i)
  })

  // --- v3: catalog domain as the last-resort (dom:) identifier -------------

  it('falls back to the domain only when there is no phone nor handle', () => {
    const domKeyed = computeDedupHash(null, null, 'https://leyvascents.mx/catalog')
    expect(domKeyed).toMatch(/^[0-9a-f]{64}$/)
    // Different namespace ("dom:") than tel:/ig: → distinct from those keys.
    expect(domKeyed).not.toBe(computeDedupHash('5512345678', null))
    expect(domKeyed).not.toBe(computeDedupHash(null, 'leyvascents'))
  })

  it('keys the domain across http/https/www/path variants identically', () => {
    const a = computeDedupHash(null, null, 'https://leyvascents.mx')
    const b = computeDedupHash(null, null, 'http://www.leyvascents.mx/catalog?page=2')
    expect(a).toBe(b)
  })

  it('does NOT change existing tel:/ig: keys when a catalog URL is also present', () => {
    // Strict priority tel > ig > dom: adding catalogUrl is additive, so a
    // previously-computed hash stays stable.
    expect(computeDedupHash('5512345678', null, 'https://leyvascents.mx')).toBe(
      computeDedupHash('5512345678', null),
    )
    expect(computeDedupHash(null, '@leyvascents', 'https://leyvascents.mx')).toBe(
      computeDedupHash(null, 'leyvascents'),
    )
  })

  it('GUARDRAIL: throws only when ALL THREE identifiers are empty', () => {
    // All three empty → still throws.
    expect(() => computeDedupHash(null, null, null)).toThrow(/cannot deduplicate/i)
    expect(() => computeDedupHash('---', '@', '   ')).toThrow(/cannot deduplicate/i)
    // A catalog URL alone is enough to deduplicate → must NOT throw.
    expect(() => computeDedupHash(null, null, 'https://leyvascents.mx')).not.toThrow()
  })
})
