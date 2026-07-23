/**
 * openai-responses — the production OpenAI Responses API client for Agente 2
 * (Sourcing Scout), running inside the container on the VM.
 *
 * WHY THIS MODULE EXISTS (and is new, not a refactor of the smoke):
 *   The verified request shape lived ONLY inside scripts/smoke-sourcing.ts as
 *   non-exported functions (buildRequestBody / extractOutputText / the 429 retry
 *   loop). The smoke is a manual calibration tool, not importable, and it runs
 *   with reasoning.effort='medium'. Production runs with effort='low' (the closed
 *   calibration decision, mirroring A1). So this module LIFTS the smoke's
 *   byte-verified shape into a reusable surface with the PRODUCTION parameters,
 *   and the smoke is left untouched (it stays the calibration instrument).
 *
 * Parameters are all traceable to the repo — no magic numbers:
 *   - MODEL / Responses API / web_search / Structured Outputs ...... closed calibration.
 *   - REASONING_EFFORT = 'low' ...... production decision (this prompt + A1's
 *     run_logs metadata reasoningEffort:'low'); the smoke uses 'medium'.
 *   - MAX_OUTPUT_TOKENS = 45_000 ...... lifted verbatim from smoke-sourcing.ts
 *     (MAX_OUTPUT_TOKENS), whose docblock states it MUST become permanent in the
 *     production body: it caps the per-request TPM *reservation* (input + max
 *     output) to ~50-56k so a single gpt-5.4 reasoning request does not, together
 *     with A1's daily run, self-saturate the org's shared 500k tier-1 TPM pool.
 *     The last real smoke used ~12.2k output tokens, status=completed (no
 *     truncation) — so 45k is comfortable headroom, not a ceiling we hit.
 *
 * Opsec: the API key is sent ONLY as the Bearer header and never logged. Error
 * bodies pass through the repo's redactSecrets() with the key as the secret, so a
 * leaked body can never carry it.
 */

import { redactSecrets } from './scripts/brightdata-fetch.js'

// ---------------------------------------------------------------------------
// Production constants (see docblock for provenance)
// ---------------------------------------------------------------------------

export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'
export const MODEL = 'gpt-5.4'
/** PRODUCTION effort — NOT the smoke's 'medium'. */
export const REASONING_EFFORT = 'low' as const
/** Lifted from smoke-sourcing.ts — TPM-reservation cap, sized from real usage. */
export const MAX_OUTPUT_TOKENS = 45_000
/**
 * 5 min: gpt-5.4 + web_search + reasoning does multi-step research. Matches the
 * smoke's TIMEOUT_MS — 120s was measured too short during 2R.4a.
 */
export const TIMEOUT_MS = 300_000

const MAX_HTTP_RETRIES = 3 // retries AFTER the first attempt, for retryable statuses only
const RATE_LIMIT_FALLBACK_MS = 20_000 // TPM windows are 60s; wait conservatively if no hint

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The Structured Outputs schema wrapper, as stored on disk ({name,strict,schema}). */
export interface SoSchema {
  readonly name: string
  readonly strict: boolean
  readonly schema: unknown
}

export interface ApiCallResult {
  readonly statusCode: number
  readonly bodyText: string
}

export type RequestImpl = (
  body: unknown,
  opts: { readonly apiKey: string; readonly timeoutMs: number },
) => Promise<ApiCallResult>

/** Outcome of one full Responses call, already extracted + parsed. */
export interface ResponsesOutcome {
  /** The model's parsed JSON payload (the SO envelope) — ready for validateAndFilter. */
  readonly payload: unknown
  /** Raw usage block for the run_logs trace; null when not exposed. */
  readonly usage: unknown
  /** Responses API completion status: 'completed' | 'incomplete' | … */
  readonly responseStatus: string | undefined
  /** When incomplete, why (e.g. 'max_output_tokens' = truncated → cap too low). */
  readonly incompleteReason: string | null
}

// ---------------------------------------------------------------------------
// Request body — identical shape to the verified smoke, production params
// ---------------------------------------------------------------------------

export function buildRequestBody(
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

// ---------------------------------------------------------------------------
// 429 handling — copied from the smoke verbatim: a TPM/RPM rate-limit is
// retryable (the request was rejected before any work), a quota 429 is not.
// ---------------------------------------------------------------------------

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
 * How long to wait before retrying a rate-limit 429: honor OpenAI's exact "try
 * again in X.Ys" hint IN FULL (a short backoff would retry into a still-full
 * window), then the retry-after header, else a conservative fallback. Serial by
 * design — reservations never overlap against the TPM pool.
 */
function rateLimitDelayMs(bodyText: string, retryAfterHeader: string | undefined): number {
  const hint = bodyText.match(/try again in ([\d.]+)s/i)
  if (hint) return Math.ceil(Number(hint[1]) * 1000) + 500
  if (retryAfterHeader && Number.isFinite(Number(retryAfterHeader))) {
    return Number(retryAfterHeader) * 1000
  }
  return RATE_LIMIT_FALLBACK_MS
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The only network-touching code: undici POST with the serial 429/5xx retry
 * loop. Injectable so the pipeline can be unit-tested with a fake later (no test
 * authored here — the container ships with its function + this real impl).
 */
export const defaultRequestImpl: RequestImpl = async (body, { apiKey, timeoutMs }) => {
  const { request } = await import('undici')
  const payload = JSON.stringify(body)

  // One attempt at a time. Each retry waits the FULL rate-limit window before the
  // next send, so reservations never pile up against the TPM pool.
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
        return { statusCode: res.statusCode, bodyText } // billing — waiting will not help
      }
      if (attempt <= MAX_HTTP_RETRIES) {
        const retryAfter = res.headers['retry-after']
        const delay = rateLimitDelayMs(
          bodyText,
          Array.isArray(retryAfter) ? retryAfter[0] : retryAfter,
        )
        await sleep(delay)
        continue
      }
      return { statusCode: res.statusCode, bodyText }
    }

    if (res.statusCode >= 500 && attempt <= MAX_HTTP_RETRIES) {
      const delay = Math.min(8_000, 1_000 * 2 ** (attempt - 1))
      await sleep(delay)
      continue
    }

    return { statusCode: res.statusCode, bodyText }
  }
}

// ---------------------------------------------------------------------------
// Response parsing — copied from the smoke's extractOutputText
// ---------------------------------------------------------------------------

/**
 * Locate the final assistant text in a Responses API result. The `output[]`
 * array interleaves reasoning / web_search_call blocks before the `message`; we
 * walk it and concatenate every `output_text` part. Returns null when no text
 * block is present (refusal-only / empty / unexpected shape).
 */
export function extractOutputText(response: unknown): string | null {
  const out = (response as { output?: unknown })?.output
  if (!Array.isArray(out)) return null
  const parts: string[] = []
  for (const item of out) {
    if (item?.type === 'message' && Array.isArray((item as { content?: unknown }).content)) {
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

// ---------------------------------------------------------------------------
// High-level entry point used by the pipeline
// ---------------------------------------------------------------------------

/** Thrown when the call fails in a way the run cannot recover from. Message is redacted. */
export class ResponsesApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResponsesApiError'
  }
}

/**
 * Fire ONE production Responses call and return the model's parsed JSON payload
 * plus usage/status for the trace. Throws ResponsesApiError (redacted) on any
 * unrecoverable failure: network/timeout, HTTP >= 400, non-JSON body, no
 * output_text, or non-JSON output_text. The caller closes run_logs 'failed' on
 * throw — it must never persist a partial run.
 */
export async function runResponses(
  prompt: string,
  soSchema: SoSchema,
  apiKey: string,
  meta: { readonly runId: string; readonly iso: string },
  requestImpl: RequestImpl = defaultRequestImpl,
): Promise<ResponsesOutcome> {
  const body = buildRequestBody(prompt, soSchema, meta.runId, meta.iso)

  let call: ApiCallResult
  try {
    call = await requestImpl(body, { apiKey, timeoutMs: TIMEOUT_MS })
  } catch (e) {
    throw new ResponsesApiError(
      `OpenAI request failed (network/timeout): ${redactSecrets((e as Error).message, apiKey)}`,
    )
  }

  if (call.statusCode >= 400) {
    throw new ResponsesApiError(
      `OpenAI HTTP ${call.statusCode}: ${redactSecrets(call.bodyText.slice(0, 2048), apiKey)}`,
    )
  }

  let response: unknown
  try {
    response = JSON.parse(call.bodyText)
  } catch {
    throw new ResponsesApiError('OpenAI response body is not valid JSON')
  }

  const usage = (response as { usage?: unknown }).usage ?? null
  const responseStatus = (response as { status?: string }).status
  const incompleteReason =
    (response as { incomplete_details?: { reason?: string } }).incomplete_details?.reason ?? null

  const text = extractOutputText(response)
  if (text === null) {
    throw new ResponsesApiError(
      'OpenAI response had no output_text block (refusal/empty/unexpected shape)',
    )
  }

  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new ResponsesApiError('OpenAI output_text is not valid JSON')
  }

  return { payload, usage, responseStatus, incompleteReason }
}
