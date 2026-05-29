/**
 * Unit tests for computeDedupHash + its normalization helpers.
 *
 * The contract: the same provider, however its phone / handle is formatted
 * across sources, must collapse to one hash; a provider with no identifier at
 * all must throw.
 */

import { computeDedupHash, normalizeHandle, normalizePhone } from '../scripts/dedup.js'

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

  it('throws when both identifiers are null', () => {
    expect(() => computeDedupHash(null, null)).toThrow(/cannot deduplicate/i)
  })

  it('throws when both identifiers normalize to empty', () => {
    expect(() => computeDedupHash('---', '@')).toThrow(/cannot deduplicate/i)
  })
})
