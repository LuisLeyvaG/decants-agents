/**
 * Deterministic dedup-hash computation for Agente 2 (Sourcing Scout).
 *
 * The same provider surfaces across multiple web-discovery queries under
 * different display names but usually shares a WhatsApp number, an Instagram
 * handle and/or a catalog domain. We collapse those into a single stable key so
 * the UNIQUE constraint on `agent.providers.dedup_hash` can dedupe across runs.
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
 * Normalize a catalog URL to its bare registrable host (the dedup domain):
 * lowercase, scheme stripped, path/query/fragment dropped, leading "www."
 * removed, plus any userinfo / port. So all of these collapse to "leyvascents.mx":
 *
 *   - "https://leyvascents.mx"
 *   - "http://www.leyvascents.mx/"
 *   - "https://www.leyvascents.mx/catalog?page=2"
 *   - "leyvascents.mx/catalog"
 *
 * Returns "" when nothing host-like can be extracted (e.g. an empty string), so
 * callers can treat it as "no domain identifier".
 */
export function normalizeDomain(raw: string): string {
  let s = raw.trim().toLowerCase()
  if (s === '') return ''
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '') // strip scheme "https://"
  s = s.replace(/[/?#].*$/, '') // drop path / query / fragment
  s = s.replace(/^[^@]*@/, '') // drop userinfo "user:pass@"
  s = s.replace(/:\d+$/, '') // drop ":port"
  s = s.replace(/^www\./, '') // drop leading "www."
  return s
}

/**
 * Compute the dedup hash for a provider from its WhatsApp number, Instagram
 * handle and catalog URL, keyed on the STRONGEST identifier available rather
 * than on the combination.
 *
 * Strict priority: tel > ig > dom.
 *   - The phone is the strongest signal (a business changes its IG handle / its
 *     domain far more often than its WhatsApp line), so it wins when present.
 *   - The Instagram handle is the second fallback.
 *   - The catalog DOMAIN is the last-resort fallback, used ONLY when both phone
 *     and handle are absent. It is deliberately NOT treated as the strongest
 *     identifier: two sub-stores under one domain, or a provider migrating
 *     domains, would otherwise collide / split incorrectly.
 *
 * Keying on a single identifier — instead of concatenating — is what makes the
 * same provider deduplicate when one run exposes the phone alone and another
 * exposes the phone plus a handle or a domain:
 *
 *     computeDedupHash('5512345678', null)                              ===
 *     computeDedupHash('5512345678', '@leyvascents', 'https://x.mx')    // both → "tel:5512345678"
 *
 * Adding `catalogUrl` is additive: existing "tel:" / "ig:" keys are unchanged,
 * so previously-computed hashes stay stable. The key is namespaced ("tel:" /
 * "ig:" / "dom:") so identifiers can never collide across namespaces.
 *
 * Returns `sha256(key)` as hex. Throws when ALL THREE identifiers are null/empty
 * (after normalization): such a provider has nothing to deduplicate on and must
 * not exist. `catalog_url` is NOT NULL in agent.providers, so upstream this case
 * should be impossible — the throw is a safety net, not the expected path.
 */
export function computeDedupHash(
  whatsapp: string | null,
  igHandle: string | null,
  catalogUrl: string | null = null,
): string {
  const phone = whatsapp === null ? '' : normalizePhone(whatsapp)
  const handle = igHandle === null ? '' : normalizeHandle(igHandle)
  const domain = catalogUrl === null ? '' : normalizeDomain(catalogUrl)

  if (phone === '' && handle === '' && domain === '') {
    throw new Error(
      'computeDedupHash: provider has no WhatsApp number, Instagram handle, nor catalog URL; cannot deduplicate.',
    )
  }

  const key =
    phone !== '' ? `tel:${phone}` : handle !== '' ? `ig:${handle}` : `dom:${domain}`
  return createHash('sha256').update(key).digest('hex')
}
