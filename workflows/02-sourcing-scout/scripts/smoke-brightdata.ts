/**
 * Sprint 2 smoke test — the ONLY real network call of this sprint. NOT a unit
 * test; it is never run by `npm test`. Run it MANUALLY:
 *
 *   node --import tsx 02-sourcing-scout/scripts/smoke-brightdata.ts
 *   # (from the `workflows/` directory; reads BrightData secrets from ./.env)
 *
 * It makes ONE real fetch to a MercadoLibre MX search page through Bright Data,
 * under a HARD $0.50 sub-limit (NOT the $2 v1 budget), and prints what came
 * back so a human can confirm it's real ML-MX HTML and not a captcha/block.
 * It writes NOTHING to Postgres or anywhere else — stdout only. It never prints
 * the proxy password.
 */

import { readFileSync } from 'node:fs'

import { CostGuard, CostGuardTrippedError } from './cost-guard.js'
import { createBrightDataFetcher } from './brightdata-fetch.js'

/** Minimal .env loader (no dotenv dependency). Only sets keys not already in env. */
function loadDotEnv(): string | null {
  const candidate = new URL('../../.env', import.meta.url) // workflows/.env
  let raw: string
  try {
    raw = readFileSync(candidate, 'utf8')
  } catch {
    return null
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
  return candidate.pathname
}

const TARGET_URL = 'https://listado.mercadolibre.com.mx/perfume-decant'
const SMOKE_BUDGET_USD = 0.5 // sub-limit for the experiment — deliberately NOT the $2 v1 budget

async function main(): Promise<void> {
  const envSource = loadDotEnv()
  console.log(`[smoke] env source: ${envSource ?? '(no .env found — relying on process.env)'}`)
  console.log(`[smoke] target: ${TARGET_URL}`)
  console.log(`[smoke] hard budget: $${SMOKE_BUDGET_USD.toFixed(2)} (sub-limit, not the $2 v1 budget)\n`)

  const guard = new CostGuard({
    maxSpendUsd: SMOKE_BUDGET_USD,
    costPerGbUsd: 8.0,
    maxConsecutiveFailures: 3,
  })

  try {
    // Validates the secrets + reads Bright Data's CA up front; throws clearly if
    // any are missing (incl. BRIGHTDATA_CA_CERT). Built inside try so that clear
    // error is reported nicely rather than crashing unhandled.
    const brightDataFetch = createBrightDataFetcher()

    // maxRetries: 1 (2 attempts max) for the smoke. With the default 3 retries a
    // hard connection failure burns 3 attempts and the breaker trips on the 4th
    // BEFORE the underlying network error is rethrown — masking the real reason.
    // Two attempts keep the consecutive-failure count below the limit, so a real
    // failure surfaces its (password-redacted) message instead of "tripped: failures".
    const result = await brightDataFetch({ url: TARGET_URL, guard, maxRetries: 1 })
    const snap = guard.snapshot()

    console.log('=== RESULT ===')
    console.log(`status:            ${result.status}`)
    console.log(`attempts:          ${result.attempts}`)
    console.log(`sessionId:         ${result.sessionId ?? '(rotating)'}`)
    console.log(`bytes transferred: ${result.bytesTransferred} (on-wire, incl. ~${2048}B header estimate)`)
    console.log(`USD spent (guard): $${snap.spentUsd.toFixed(6)}`)
    console.log(`body length:       ${result.body.length} chars (decompressed)`)

    const lower = result.body.toLowerCase()
    const looksLikeMl = lower.includes('mercadolibre') || lower.includes('mercado libre')
    const looksBlocked =
      lower.includes('captcha') || lower.includes('robot') || result.status === 403
    console.log(`looks like ML-MX:  ${looksLikeMl ? 'YES' : 'NO'}`)
    console.log(`looks blocked:     ${looksBlocked ? 'YES (captcha/403?)' : 'no'}`)

    console.log('\n=== first 500 chars of body ===')
    console.log(result.body.slice(0, 500))
  } catch (err) {
    if (err instanceof CostGuardTrippedError) {
      console.error(`\n[smoke] CostGuard tripped (${err.reason}): ${err.message}`)
      console.error(`[smoke] guard snapshot: ${JSON.stringify(guard.snapshot())}`)
    } else {
      // Errors from the wrapper are already password-redacted.
      console.error(`\n[smoke] fetch failed: ${(err as Error).message}`)
    }
    process.exitCode = 1
  }
}

void main()
