/**
 * Deterministic dedup-hash computation for Agente 2 (Sourcing Scout).
 *
 * The same provider surfaces across Google Maps, MercadoLibre and Instagram
 * under different display names but usually shares a WhatsApp number and/or an
 * Instagram handle. We collapse those into a single stable key so the UNIQUE
 * constraint on `agent.providers.dedup_hash` can dedupe across sources.
 *
 * Pure + dependency-free: only Node's built-in `crypto`. Unit-testable without
 * a DB or network.
 */

import { createHash } from 'node:crypto'

/**
 * Normalize a Mexican phone number to its 10-digit national form (digits only).
 *
 *   - Remove everything that is not a digit (drops "+", spaces, dashes,
 *     parentheses).
 *   - Strip the "52" country prefix when present: a number carrying it is at
 *     least 12 digits ("52" + the 10-digit national number, optionally + the "1"
 *     mobile marker), so "525512345678" (12) → "5512345678" (10). A genuine
 *     10-digit number that merely starts with "52" is left untouched (length is
 *     not >= 12).
 *   - Strip the legacy "1" mobile marker: after the country code is gone,
 *     "+52 1 55 1234 5678" leaves "15512345678" (11 digits) — the leading "1"
 *     is dropped so it collapses onto the same 10-digit number as the non-"1"
 *     form. Without this, the same cell written with vs. without the "1" would
 *     hash differently and fail to deduplicate.
 */
export function normalizePhone(raw: string): string {
  let digits = raw.replace(/\D/g, '')
  if (digits.length >= 12 && digits.startsWith('52')) {
    digits = digits.slice(2)
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    digits = digits.slice(1)
  }
  return digits
}

/**
 * Normalize an Instagram handle: trim, lowercase, and drop every "@".
 * "@LeyvaScents" and " leyvascents " both normalize to "leyvascents".
 */
export function normalizeHandle(raw: string): string {
  return raw.trim().toLowerCase().replace(/@/g, '')
}

/**
 * Compute the dedup hash for a provider from its WhatsApp number and Instagram
 * handle, keyed on the STRONGEST identifier available rather than on the pair.
 *
 * The phone number is the strongest signal (a business changes its IG handle far
 * more often than its WhatsApp line), so it wins when present; the handle is the
 * fallback. Keying on a single identifier — instead of concatenating both — is
 * what makes the same provider deduplicate when one source exposes the phone
 * alone and another exposes the phone plus a handle:
 *
 *     computeDedupHash('5512345678', null)         ===
 *     computeDedupHash('5512345678', '@leyvascents')   // both → key "tel:5512345678"
 *
 * The key is namespaced ("tel:" / "ig:") so a phone and a handle can never
 * collide on the same digits.
 *
 * Returns `sha256(key)` as hex. Throws when BOTH identifiers are null/empty
 * (after normalization): such a provider has nothing to deduplicate on.
 */
export function computeDedupHash(
  whatsapp: string | null,
  igHandle: string | null,
): string {
  const phone = whatsapp === null ? '' : normalizePhone(whatsapp)
  const handle = igHandle === null ? '' : normalizeHandle(igHandle)

  if (phone === '' && handle === '') {
    throw new Error(
      'computeDedupHash: provider has neither a WhatsApp number nor an Instagram handle; cannot deduplicate.',
    )
  }

  const key = phone !== '' ? `tel:${phone}` : `ig:${handle}`
  return createHash('sha256').update(key).digest('hex')
}
