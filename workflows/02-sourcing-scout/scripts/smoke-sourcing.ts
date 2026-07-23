/**
 * Sprint 2R.4a — Sourcing Scout (A2) calibration smoke. NOT a unit test; never
 * run by `npm test`. Run it MANUALLY from the `workflows/` directory:
 *
 *   node --import tsx 02-sourcing-scout/scripts/smoke-sourcing.ts --runs=2
 *   node --import tsx 02-sourcing-scout/scripts/smoke-sourcing.ts --dry-run   # pre-flight only, no API call
 *
 * What it does: fires N real OpenAI Responses API calls (gpt-5.4 + web_search,
 * the twin of A1's workflow), runs each raw output through the SAME deterministic
 * validateAndFilter the production workflow uses, and prints + dumps the raw
 * scores so a human can calibrate TRUST_QUALITY_THRESHOLD / CONFIDENCE_THRESHOLD
 * by hand. It writes NOTHING to Postgres — stdout + a gitignored JSON dump only,
 * and it never prints the OpenAI key.
 *
 * The thresholds it highlights against are HYPOTHESES (see validate-and-filter.ts);
 * this smoke is the evidence to move them. The script does NOT change them.
 *
 * Design notes:
 *   - The prompt on disk (system-prompt.generated.md) is GITIGNORED, so we never
 *     trust it: we regenerate it via `npm run build:prompt` and abort loudly if
 *     it is missing or still carries an unresolved {{marker}}.
 *   - The network call sits behind an injectable `requestImpl` so it can be
 *     tested dry later (no test written here — this is a smoke).
 *   - Secrets never reach a log or the dump: errors/bodies are passed through
 *     the repo's redactSecrets() with the key as the secret.
 */

import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { ulid } from 'ulid'

import {
  CONFIDENCE_THRESHOLD,
  TRUST_QUALITY_THRESHOLD,
  validateAndFilter,
  type ValidateAndFilterResult,
} from '../validate-and-filter.js'
import { normalizeDomain } from './dedup.js'
import { redactSecrets } from './brightdata-fetch.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'
const MODEL = 'gpt-5.4'
const REASONING_EFFORT = 'medium'
const TIMEOUT_MS = 300_000 // 5 min: gpt-5.4 + web_search + reasoning=medium does multi-step research; 120s was too short (2R.4a smoke)
/**
 * Caps the per-request TPM RESERVATION. The rate limiter counts the reserved
 * budget (input + max_output), not actual usage — an uncapped gpt-5.4 reasoning
 * request reserves ~90-100k, and a handful in one rolling minute self-saturate
 * the org's 500k TPM pool. Capping output to 45k drops the reservation to
 * ~50-56k so a single run fits comfortably. Check `incomplete_details.reason`
 * in the output: if it is 'max_output_tokens', the run truncated and this cap
 * must rise. (2R.4b: this must become PERMANENT in the production workflow body,
 * sized from real usage measured here.)
 */
const MAX_OUTPUT_TOKENS = 45_000
const DEFAULT_RUNS = 2
const MAX_RUNS = 3
const BORDERLINE_DELTA = 0.05
const RAW_DUMP_MAX = 2048

// File locations, resolved relative to this script (02-sourcing-scout/scripts/).
const GENERATED_PROMPT_URL = new URL(
  '../prompts/system-prompt.generated.md',
  import.meta.url,
)
const SO_SCHEMA_URL = new URL(
  '../schemas/sourcing-scout-output.schema.json',
  import.meta.url,
)
const TMP_DIR_URL = new URL('../tmp/', import.meta.url)
const WORKFLOWS_ROOT_URL = new URL('../../', import.meta.url) // workflows/
const DOTENV_URL = new URL('../../.env', import.meta.url) // workflows/.env

// ---------------------------------------------------------------------------
// .env loader (clone of smoke-brightdata's — no dotenv dep; only sets unset keys)
// ---------------------------------------------------------------------------

function loadDotEnv(): string | null {
  let raw: string
  try {
    raw = readFileSync(DOTENV_URL, 'utf8')
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
  return fileURLToPath(DOTENV_URL)
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  readonly runs: number
  readonly force: boolean
  readonly dryRun: boolean
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let runs = DEFAULT_RUNS
  let force = false
  let dryRun = false
  for (const arg of argv) {
    if (arg === '--force') force = true
    else if (arg === '--dry-run') dryRun = true
    else if (arg.startsWith('--runs=')) {
      const n = Number(arg.slice('--runs='.length))
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`--runs must be a positive integer, got "${arg}"`)
      }
      runs = n
    } else {
      throw new Error(`Unknown argument: "${arg}"`)
    }
  }
  if (runs > MAX_RUNS && !force) {
    throw new Error(
      `--runs=${runs} exceeds the soft cap of ${MAX_RUNS}. Each run is a paid ` +
        `gpt-5.4 call with web_search. Re-run with --force if you really mean it.`,
    )
  }
  return { runs, force, dryRun }
}

// ---------------------------------------------------------------------------
// Pre-flight: fresh prompt + schema + key
// ---------------------------------------------------------------------------

/** Regenerate the prompt, then read it. Aborts loudly if stale/missing/unresolved. */
function ensureFreshPrompt(): string {
  console.log('[smoke] regenerating prompt via `npm run build:prompt`…')
  execSync('npm run build:prompt', {
    cwd: fileURLToPath(WORKFLOWS_ROOT_URL),
    stdio: 'inherit',
  })

  let content: string
  try {
    content = readFileSync(GENERATED_PROMPT_URL, 'utf8')
  } catch (e) {
    throw new Error(
      `Resolved prompt not found at ${fileURLToPath(GENERATED_PROMPT_URL)} ` +
        `after build:prompt. This file is gitignored and must be generated. ` +
        `Underlying error: ${(e as Error).message}`,
    )
  }
  if (content.trim() === '') {
    throw new Error('Resolved prompt is empty after build:prompt — aborting.')
  }
  if (content.includes('{{')) {
    const marker = content.slice(content.indexOf('{{'), content.indexOf('{{') + 60)
    throw new Error(
      `Resolved prompt still contains an unresolved marker (e.g. "${marker}…"). ` +
        `build:prompt did not substitute everything — aborting before spending tokens.`,
    )
  }
  return content
}

interface SoSchema {
  readonly name: string
  readonly strict: boolean
  readonly schema: unknown
}

function loadSoSchema(): SoSchema {
  const raw = readFileSync(SO_SCHEMA_URL, 'utf8')
  const parsed = JSON.parse(raw) as SoSchema
  if (!parsed.name || !parsed.schema) {
    throw new Error(
      `SO schema at ${fileURLToPath(SO_SCHEMA_URL)} is missing name/schema.`,
    )
  }
  return parsed
}

function readApiKey(): string {
  const key = process.env.OPENAI_API_KEY
  if (key === undefined || key.trim() === '') {
    throw new Error(
      'OPENAI_API_KEY is not set. Add it to workflows/.env (direct OpenAI API ' +
        'key; the smoke sends `Authorization: Bearer <key>`). Aborting before any call.',
    )
  }
  return key.trim()
}

// ---------------------------------------------------------------------------
// Request body + API call (injectable requestImpl for dry testing later)
// ---------------------------------------------------------------------------

function buildRequestBody(
  prompt: string,
  soSchema: SoSchema,
  runId: string,
  iso: string,
): unknown {
  const userMessage = `Run the Sourcing Scout now. Run ID: ${runId}. Timestamp: ${iso}.`
  return {
    model: MODEL,
    instructions: prompt,
    input: [{ role: 'user', content: userMessage }],
    tools: [{ type: 'web_search' }],
    text: {
      format: {
        type: 'json_schema',
        ...soSchema,
      },
    },
    reasoning: { effort: REASONING_EFFORT },
    max_output_tokens: MAX_OUTPUT_TOKENS,
    store: false,
  }
}

interface ApiCallResult {
  readonly statusCode: number
  readonly bodyText: string
}

type RequestImpl = (
  body: unknown,
  opts: { apiKey: string; timeoutMs: number },
) => Promise<ApiCallResult>

const MAX_HTTP_RETRIES = 3 // retries AFTER the first attempt, for retryable statuses only
const RATE_LIMIT_FALLBACK_MS = 20_000 // TPM windows are 60s; wait conservatively if no hint

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Classify a 429. A TPM/RPM rate-limit clears on its own and is safe to retry
 * (the request was rejected BEFORE any completion work). A quota/billing 429
 * (`insufficient_quota`) will NOT clear by waiting — retrying it is pointless
 * and must abort instead.
 */
function classify429(bodyText: string): 'rate_limit' | 'quota' {
  try {
    const err = (JSON.parse(bodyText) as { error?: { code?: string; type?: string } }).error
    if (err?.code === 'insufficient_quota' || err?.type === 'insufficient_quota') {
      return 'quota'
    }
  } catch {
    /* unparseable → assume rate_limit (retryable) */
  }
  return 'rate_limit'
}

/**
 * How long to wait before retrying a rate-limit 429: honor OpenAI's exact
 * "Please try again in X.Ys" hint IN FULL (no short backoff that would retry
 * into a still-full window), then the `retry-after` header, else a conservative
 * fallback. Crucially serial — never overlap reservations.
 */
function rateLimitDelayMs(bodyText: string, retryAfterHeader: string | undefined): number {
  const hint = bodyText.match(/try again in ([\d.]+)s/i)
  if (hint) return Math.ceil(Number(hint[1]) * 1000) + 500 // full hinted wait + small cushion
  if (retryAfterHeader && Number.isFinite(Number(retryAfterHeader))) {
    return Number(retryAfterHeader) * 1000
  }
  return RATE_LIMIT_FALLBACK_MS
}

const defaultRequestImpl: RequestImpl = async (body, { apiKey, timeoutMs }) => {
  const { request } = await import('undici')
  const payload = JSON.stringify(body)

  // One attempt at a time. Each retry waits the FULL rate-limit window before
  // the next send, so reservations never pile up against the TPM pool.
  let attempt = 0
  while (true) {
    attempt += 1
    const res = await request(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const bodyText = await res.body.text()

    if (res.statusCode === 429) {
      if (classify429(bodyText) === 'quota') {
        // Billing/quota — waiting will not help. Surface it to the caller.
        return { statusCode: res.statusCode, bodyText }
      }
      if (attempt <= MAX_HTTP_RETRIES) {
        const retryAfter = res.headers['retry-after']
        const delay = rateLimitDelayMs(
          bodyText,
          Array.isArray(retryAfter) ? retryAfter[0] : retryAfter,
        )
        console.log(
          `[smoke]   HTTP 429 rate_limit (attempt ${attempt}/${MAX_HTTP_RETRIES + 1}); ` +
            `waiting the full ${(delay / 1000).toFixed(1)}s window before the next send…`,
        )
        await sleep(delay)
        continue
      }
      return { statusCode: res.statusCode, bodyText }
    }

    if (res.statusCode >= 500 && attempt <= MAX_HTTP_RETRIES) {
      const delay = Math.min(8_000, 1_000 * 2 ** (attempt - 1))
      console.log(
        `[smoke]   HTTP ${res.statusCode} (attempt ${attempt}/${MAX_HTTP_RETRIES + 1}); ` +
          `retrying in ${(delay / 1000).toFixed(1)}s…`,
      )
      await sleep(delay)
      continue
    }

    return { statusCode: res.statusCode, bodyText }
  }
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Locate the final assistant text in a Responses API result. The `output[]`
 * array interleaves reasoning / web_search_call blocks before the `message`;
 * we walk it and concatenate every `output_text` part. Returns null when no
 * text block is present (refusal-only / empty / unexpected shape).
 */
function extractOutputText(response: unknown): string | null {
  const out = (response as { output?: unknown })?.output
  if (!Array.isArray(out)) return null
  const parts: string[] = []
  for (const item of out) {
    if (
      item?.type === 'message' &&
      Array.isArray((item as { content?: unknown }).content)
    ) {
      for (const c of (item as { content: unknown[] }).content) {
        if (
          (c as { type?: unknown })?.type === 'output_text' &&
          typeof (c as { text?: unknown }).text === 'string'
        ) {
          parts.push((c as { text: string }).text)
        }
      }
    }
  }
  return parts.length > 0 ? parts.join('') : null
}

function truncate(s: string, max = RAW_DUMP_MAX): string {
  return s.length > max ? `${s.slice(0, max)}… [+${s.length - max} chars]` : s
}

// ---------------------------------------------------------------------------
// Per-run execution
// ---------------------------------------------------------------------------

interface RunOutcome {
  readonly runIndex: number
  readonly runId: string
  readonly startedAt: string
  readonly httpStatus: number
  readonly usage: unknown
  /** Responses API completion status: 'completed' | 'incomplete' | … */
  readonly responseStatus?: string
  /** When status==='incomplete', why (e.g. 'max_output_tokens' = truncated → raise cap). */
  readonly incompleteReason?: string | null
  /** Set when the call failed / output could not be parsed; raw is truncated. */
  readonly failure?: { reason: string; rawTruncated: string }
  /** validateAndFilter result when we got parseable JSON; null on failure. */
  readonly result: ValidateAndFilterResult | null
}

async function executeRun(
  runIndex: number,
  prompt: string,
  soSchema: SoSchema,
  apiKey: string,
  requestImpl: RequestImpl,
): Promise<RunOutcome> {
  const runId = ulid()
  const startedAt = new Date().toISOString()
  const body = buildRequestBody(prompt, soSchema, runId, startedAt)

  let call: ApiCallResult
  try {
    call = await requestImpl(body, { apiKey, timeoutMs: TIMEOUT_MS })
  } catch (e) {
    return {
      runIndex,
      runId,
      startedAt,
      httpStatus: 0,
      usage: null,
      failure: {
        reason: `network/timeout error: ${redactSecrets((e as Error).message, apiKey)}`,
        rawTruncated: '',
      },
      result: null,
    }
  }

  // HTTP error: dump the redacted body so the cause (auth / rate / refusal) is visible.
  if (call.statusCode >= 400) {
    return {
      runIndex,
      runId,
      startedAt,
      httpStatus: call.statusCode,
      usage: null,
      failure: {
        reason: `HTTP ${call.statusCode}`,
        rawTruncated: redactSecrets(truncate(call.bodyText), apiKey),
      },
      result: null,
    }
  }

  let response: unknown
  try {
    response = JSON.parse(call.bodyText)
  } catch {
    return {
      runIndex,
      runId,
      startedAt,
      httpStatus: call.statusCode,
      usage: null,
      failure: {
        reason: 'response body is not valid JSON',
        rawTruncated: redactSecrets(truncate(call.bodyText), apiKey),
      },
      result: null,
    }
  }

  const usage = (response as { usage?: unknown }).usage ?? null
  const responseStatus = (response as { status?: string }).status
  const incompleteReason =
    (response as { incomplete_details?: { reason?: string } }).incomplete_details?.reason ?? null
  const text = extractOutputText(response)
  if (text === null) {
    return {
      runIndex,
      runId,
      startedAt,
      httpStatus: call.statusCode,
      usage,
      responseStatus,
      incompleteReason,
      failure: {
        reason: 'no output_text block found in response.output[]',
        rawTruncated: redactSecrets(truncate(JSON.stringify(response)), apiKey),
      },
      result: null,
    }
  }

  // Parse the model's JSON payload BEFORE handing to validateAndFilter so a
  // malformed payload surfaces here with its raw text, not as a silent throw.
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return {
      runIndex,
      runId,
      startedAt,
      httpStatus: call.statusCode,
      usage,
      responseStatus,
      incompleteReason,
      failure: {
        reason: 'output_text is not valid JSON',
        rawTruncated: redactSecrets(truncate(text), apiKey),
      },
      result: null,
    }
  }

  return {
    runIndex,
    runId,
    startedAt,
    httpStatus: call.statusCode,
    usage,
    responseStatus,
    incompleteReason,
    result: validateAndFilter(payload, runId),
  }
}

// ---------------------------------------------------------------------------
// stdout rendering
// ---------------------------------------------------------------------------

function isBorderline(trustQuality: number, confidence: number): boolean {
  return (
    Math.abs(trustQuality - TRUST_QUALITY_THRESHOLD) <= BORDERLINE_DELTA ||
    Math.abs(confidence - CONFIDENCE_THRESHOLD) <= BORDERLINE_DELTA
  )
}

function fmtScore(n: number): string {
  return n.toFixed(2)
}

function row(
  name: string,
  tq: number,
  conf: number,
  extra = '',
): string {
  const mark = isBorderline(tq, conf) ? ' «BORDERLINE»' : ''
  const namePadded = name.length > 38 ? `${name.slice(0, 37)}…` : name.padEnd(38)
  return `    ${namePadded}  tq=${fmtScore(tq)}  conf=${fmtScore(conf)}${extra}${mark}`
}

function renderRun(outcome: RunOutcome): void {
  console.log(
    `\n──────── RUN ${outcome.runIndex} (runId=${outcome.runId}) ────────`,
  )
  if (outcome.responseStatus) {
    const flag =
      outcome.incompleteReason === 'max_output_tokens'
        ? '  ⚠ TRUNCATED — raise MAX_OUTPUT_TOKENS'
        : outcome.incompleteReason
          ? `  ⚠ incomplete: ${outcome.incompleteReason}`
          : ''
    console.log(`  response.status=${outcome.responseStatus}${flag}`)
  }
  if (outcome.failure) {
    console.log(`  ✖ FAILED: ${outcome.failure.reason}`)
    if (outcome.failure.rawTruncated) {
      console.log(`  --- raw (truncated) ---\n${outcome.failure.rawTruncated}`)
    }
    return
  }
  const result = outcome.result
  if (!result) return

  if (result.status === 'parse_failed') {
    console.log('  ✖ validateAndFilter: parse_failed (envelope rejected)')
    for (const issue of result.error.issues.slice(0, 10)) {
      console.log(`      - [${issue.path.join('.') || '(root)'}] ${issue.message}`)
    }
    return
  }

  const { stats, accepted, filteredOut, rejected, duplicates } = result
  console.log(
    `  stats: total=${stats.totalCandidates} accepted=${stats.acceptedCount} ` +
      `filteredOut=${stats.filteredOutCount} rejected=${stats.rejectedCount} ` +
      `duplicatesDropped=${stats.duplicatesDropped}`,
  )

  console.log(`  ACCEPTED (${accepted.length}):`)
  for (const { provider } of accepted) {
    console.log(row(provider.name, provider.trust_quality, provider.confidence))
  }

  console.log(`  FILTERED OUT (${filteredOut.length}):`)
  for (const { provider, reason } of filteredOut) {
    console.log(
      row(provider.name, provider.trust_quality, provider.confidence, `  reason=${reason}`),
    )
  }

  if (duplicates.length > 0) {
    console.log(`  DUPLICATES IN RUN (${duplicates.length}):`)
    for (const { provider } of duplicates) {
      console.log(`    ${provider.name} → collapsed onto an earlier accepted hash`)
    }
  }

  console.log(`  REJECTED (${rejected.length}):`)
  for (const r of rejected) {
    const issues = r.error
      ? r.error.issues
          .slice(0, 3)
          .map((i) => `[${i.path.join('.') || '(root)'}] ${i.message}`)
          .join('; ')
      : '(no ZodError — code rule)'
    console.log(`    reason=${r.reason}  ${issues}`)
  }
}

// ---------------------------------------------------------------------------
// Cross-run variance view (uniform identity = normalized catalog domain)
// ---------------------------------------------------------------------------

interface Observation {
  readonly runIndex: number
  readonly name: string
  readonly partition: 'accepted' | 'filteredOut'
  readonly trustQuality: number
  readonly confidence: number
  readonly dedupHash?: string
}

function collectObservations(outcomes: readonly RunOutcome[]): Map<string, Observation[]> {
  const byDomain = new Map<string, Observation[]>()
  const add = (domain: string, obs: Observation): void => {
    const list = byDomain.get(domain) ?? []
    list.push(obs)
    byDomain.set(domain, list)
  }
  for (const outcome of outcomes) {
    const r = outcome.result
    if (!r || r.status !== 'ok') continue
    for (const { provider } of r.accepted) {
      add(normalizeDomain(provider.catalog_url), {
        runIndex: outcome.runIndex,
        name: provider.name,
        partition: 'accepted',
        trustQuality: provider.trust_quality,
        confidence: provider.confidence,
        dedupHash: provider.dedup_hash,
      })
    }
    for (const { provider } of r.filteredOut) {
      add(normalizeDomain(provider.catalog_url), {
        runIndex: outcome.runIndex,
        name: provider.name,
        partition: 'filteredOut',
        trustQuality: provider.trust_quality,
        confidence: provider.confidence,
      })
    }
  }
  return byDomain
}

function renderVariance(byDomain: Map<string, Observation[]>): void {
  console.log('\n════════ CROSS-RUN VARIANCE (providers seen in >1 run) ════════')
  console.log('Identity = normalized catalog domain (uniform across partitions).')
  let any = false
  for (const [domain, observations] of byDomain) {
    const runs = new Set(observations.map((o) => o.runIndex))
    if (runs.size < 2) continue
    any = true
    const driftsPartition = new Set(observations.map((o) => o.partition)).size > 1
    console.log(`\n  ${domain}${driftsPartition ? '   ⚠ PARTITION DRIFT' : ''}`)
    for (const o of observations.sort((a, b) => a.runIndex - b.runIndex)) {
      const hash = o.dedupHash ? `  hash=${o.dedupHash.slice(0, 12)}…` : ''
      console.log(
        `    run ${o.runIndex}: ${o.partition.padEnd(11)} ` +
          `tq=${fmtScore(o.trustQuality)} conf=${fmtScore(o.confidence)}` +
          `${hash}  (${o.name})`,
      )
    }
  }
  if (!any) {
    console.log('  (no provider appeared in more than one run)')
  }
}

// ---------------------------------------------------------------------------
// Dump (serializable: ZodErrors → issues)
// ---------------------------------------------------------------------------

function toSerializable(result: ValidateAndFilterResult | null): unknown {
  if (!result) return null
  if (result.status === 'parse_failed') {
    return { status: 'parse_failed', runId: result.runId, issues: result.error.issues }
  }
  return {
    status: result.status,
    runId: result.runId,
    stats: result.stats,
    accepted: result.accepted,
    filteredOut: result.filteredOut,
    rejected: result.rejected.map((r) => ({
      raw: r.raw,
      reason: r.reason,
      issues: r.error ? r.error.issues : undefined,
    })),
    duplicates: result.duplicates,
  }
}

function writeDump(outcomes: readonly RunOutcome[]): string {
  mkdirSync(fileURLToPath(TMP_DIR_URL), { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-') // Windows-safe filename
  const fileName = `smoke-sourcing-${stamp}.json`
  const dump = outcomes.map((o) => ({
    runIndex: o.runIndex,
    runId: o.runId,
    startedAt: o.startedAt,
    model: MODEL,
    reasoningEffort: REASONING_EFFORT,
    httpStatus: o.httpStatus,
    usage: o.usage,
    responseStatus: o.responseStatus ?? null,
    incompleteReason: o.incompleteReason ?? null,
    failure: o.failure ?? null,
    result: toSerializable(o.result),
  }))
  const target = new URL(fileName, TMP_DIR_URL)
  writeFileSync(target, `${JSON.stringify(dump, null, 2)}\n`, 'utf8')
  return fileURLToPath(target)
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function renderSummary(
  outcomes: readonly RunOutcome[],
  byDomain: Map<string, Observation[]>,
): void {
  console.log('\n════════ SUMMARY ════════')

  let inTokens = 0
  let outTokens = 0
  let haveUsage = false
  for (const o of outcomes) {
    const u = o.usage as { input_tokens?: number; output_tokens?: number } | null
    if (u && (typeof u.input_tokens === 'number' || typeof u.output_tokens === 'number')) {
      haveUsage = true
      inTokens += u.input_tokens ?? 0
      outTokens += u.output_tokens ?? 0
    }
  }
  if (haveUsage) {
    console.log(
      `  tokens (sum): input=${inTokens} output=${outTokens} total=${inTokens + outTokens}`,
    )
    console.log('  (web_search calls are billed separately and are NOT in these token counts.)')
  } else {
    console.log('  usage tokens: not exposed by the response.')
  }

  console.log(`  unique providers seen (by domain): ${byDomain.size}`)
  console.log(
    `  current thresholds: TRUST_QUALITY_THRESHOLD=${TRUST_QUALITY_THRESHOLD} ` +
      `CONFIDENCE_THRESHOLD=${CONFIDENCE_THRESHOLD}`,
  )
  console.log(
    '  REMINDER: these thresholds are HYPOTHESES. Adjust them by hand in ' +
      'validate-and-filter.ts based on the scores above + the JSON dump.',
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  const envSource = loadDotEnv()
  console.log(`[smoke] env source: ${envSource ?? '(no .env found — relying on process.env)'}`)

  // Pre-flight (always runs; this is the checkpoint surface).
  const prompt = ensureFreshPrompt()
  console.log(`[smoke] prompt: fresh, ${prompt.length} chars, no unresolved markers ✓`)

  const soSchema = loadSoSchema()
  console.log(`[smoke] SO schema: "${soSchema.name}" strict=${soSchema.strict} loaded ✓`)

  const apiKey = readApiKey()
  console.log('[smoke] OPENAI_API_KEY: present ✓ (never logged)')

  console.log(
    `\n[smoke] PLAN: ${args.runs} run(s) of ${MODEL} + web_search, reasoning=${REASONING_EFFORT}, ` +
      `max_output_tokens=${MAX_OUTPUT_TOKENS} (TPM reservation ~${Math.round((MAX_OUTPUT_TOKENS + 10_000) / 1000)}k).`,
  )
  console.log(
    `[smoke] ⚠ COST: this spends REAL tokens — ~${args.runs}× a full Sourcing Scout ` +
      `completion plus ${args.runs}× web_search usage. No Postgres writes.`,
  )

  if (args.dryRun) {
    console.log('\n[smoke] --dry-run set: pre-flight OK, stopping BEFORE any API call.')
    return
  }

  const outcomes: RunOutcome[] = []
  for (let i = 1; i <= args.runs; i++) {
    console.log(`\n[smoke] launching run ${i}/${args.runs}…`)
    outcomes.push(await executeRun(i, prompt, soSchema, apiKey, defaultRequestImpl))
  }

  for (const outcome of outcomes) renderRun(outcome)

  const byDomain = collectObservations(outcomes)
  renderVariance(byDomain)

  const dumpPath = writeDump(outcomes)
  console.log(`\n[smoke] raw dump written: ${dumpPath}`)

  renderSummary(outcomes, byDomain)
}

void main().catch((err) => {
  console.error(`\n[smoke] aborted: ${(err as Error).message}`)
  process.exitCode = 1
})
