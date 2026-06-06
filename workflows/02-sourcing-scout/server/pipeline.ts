/**
 * pipeline — the pure-ish orchestration of ONE Sourcing Scout run, with no
 * Postgres and no HTTP concerns: prompt + SO schema → OpenAI Responses →
 * validateAndFilter → checkLiveness → assemble the final DB rows. The server
 * wraps this with the HTTP surface and the persistence calls.
 *
 * It reuses the repo's tested logic BY IMPORT and never reimplements it:
 *   - validateAndFilter (pure: envelope parse + per-item classify + dedup)
 *   - checkLiveness     (async: GET each accepted storefront over the VM's IP)
 *   - ProviderSchema    (whole-record assertion before persistence)
 *
 * Field ownership at assembly — A2 stamps ONLY what it owns:
 *   - validateAndFilter already computed `dedup_hash` on each accepted record.
 *   - A2 injects the system fields it does NOT emit but the contract requires:
 *       trust_fulfillment: null   (A4 measures it later)
 *       last_verified_at:  null   (A4 sets it later)
 *     then ProviderSchema.parse asserts the COMPLETE record (the single place the
 *     whole record is assembled — see validate-and-filter.ts docblock step 5).
 *   - id (ULID) + run_id are added last: they live OUTSIDE ProviderSchema by
 *     design, so they are attached after the parse, for the INSERT only.
 */

import { readFileSync } from 'node:fs'

import { ulid } from 'ulid'

import { ProviderSchema, type Provider } from '../schemas/provider.schema.js'
import { validateAndFilter } from '../validate-and-filter.js'
import { checkLiveness } from '../liveness-check.js'
import { runResponses, type SoSchema } from '../openai-responses.js'
import type { ProviderRow, RunCounts } from './persistence.js'

// File locations, resolved relative to this module (02-sourcing-scout/server/).
// The generated prompt is a BUILD ARTIFACT baked into the image by the Dockerfile
// (`npm run build:prompt`); the SO schema is committed in the repo.
const GENERATED_PROMPT_URL = new URL('../prompts/system-prompt.generated.md', import.meta.url)
const SO_SCHEMA_URL = new URL('../schemas/sourcing-scout-output.schema.json', import.meta.url)

// ---------------------------------------------------------------------------
// Startup loads — read once, validate loudly. A bad prompt/schema must crash the
// container at boot, not silently produce a degraded run.
// ---------------------------------------------------------------------------

/** Read the baked, resolved prompt. Aborts if missing/empty/unresolved (stray {{marker}}). */
export function loadPrompt(): string {
  let content: string
  try {
    content = readFileSync(GENERATED_PROMPT_URL, 'utf8')
  } catch (e) {
    throw new Error(
      `Resolved prompt not found — it must be generated into the image at build ` +
        `time via \`npm run build:prompt\`. Underlying error: ${(e as Error).message}`,
    )
  }
  if (content.trim() === '') throw new Error('Resolved prompt is empty — aborting.')
  if (content.includes('{{')) {
    const marker = content.slice(content.indexOf('{{'), content.indexOf('{{') + 60)
    throw new Error(`Resolved prompt has an unresolved marker (e.g. "${marker}…") — aborting.`)
  }
  return content
}

/** Read + shape-check the committed Structured Outputs schema. */
export function loadSoSchema(): SoSchema {
  const parsed = JSON.parse(readFileSync(SO_SCHEMA_URL, 'utf8')) as SoSchema
  if (!parsed.name || !parsed.schema) {
    throw new Error('SO schema is missing name/schema — aborting.')
  }
  return parsed
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

export interface PipelineResult {
  readonly rows: ReadonlyArray<ProviderRow>
  readonly counts: RunCounts
  /** Trace detail folded into the run_logs metadata (no secrets). */
  readonly metadata: Record<string, unknown>
}

/** Raised when the model returned a structurally broken envelope — the run aborts. */
export class PipelineParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PipelineParseError'
  }
}

export interface PipelineInput {
  readonly runId: string
  readonly openaiApiKey: string
  readonly prompt: string
  readonly soSchema: SoSchema
}

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const { runId, openaiApiKey, prompt, soSchema } = input
  const iso = new Date().toISOString()

  // 1. OpenAI — throws ResponsesApiError (redacted) on any unrecoverable failure.
  const outcome = await runResponses(prompt, soSchema, openaiApiKey, { runId, iso })

  // 2. Deterministic validate + filter (the SAME pure function the smoke uses).
  const result = validateAndFilter(outcome.payload, runId)
  if (result.status === 'parse_failed') {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `[${i.path.join('.') || '(root)'}] ${i.message}`)
      .join('; ')
    throw new PipelineParseError(`Model output failed envelope parse: ${issues}`)
  }

  // 3. Liveness over the ACCEPTED partition only (filteredOut/rejected never persist).
  const liveness = await checkLiveness(result.accepted)

  // 4. Assemble the complete DB rows. PROVISIONAL (parche A2): persist BOTH the
  // proved-alive (2xx) AND the inconclusive providers; only proved-dead (DNS /
  // refused / 404 / 410 / no_url) is dropped. The liveness GET egresses from the
  // VM's datacenter IP, so 403/429/timeout are overwhelmingly WAF/IP blocks, not
  // death — discarding them loses live stores (run #59: 6/7 drops were http_403).
  // The real liveness cut returns with the Bright Data MX proxy (see TODO.md).
  // last_verified_at stays null so a future proxied re-check revalidates them.
  const writable = [...liveness.alive, ...liveness.inconclusive]
  const rows: ProviderRow[] = writable.map((o) => {
    const rec = o.provider.provider // AcceptedRecord = ProviderRaw + dedup_hash
    const full: Provider = ProviderSchema.parse({
      ...rec,
      trust_fulfillment: null,
      last_verified_at: null,
    })
    return { ...full, id: ulid(), run_id: runId }
  })

  const counts: RunCounts = {
    emitted: result.stats.totalCandidates,
    accepted: result.stats.acceptedCount,
    dead: liveness.stats.deadCount,
    duplicates: result.stats.duplicatesDropped,
    written: rows.length,
    rejected: result.stats.rejectedCount,
  }

  // Trace detail — names + reasons only, never a secret. `filteredOut` is not in
  // the response counts contract but is logged here for calibration visibility.
  const metadata: Record<string, unknown> = {
    filteredOut: result.stats.filteredOutCount,
    // PROVISIONAL liveness counters — measure how much the datacenter-IP WAF is
    // costing us until the proxy lands: inconclusive providers were KEPT this run.
    inconclusiveKept: liveness.stats.inconclusiveCount,
    responseStatus: outcome.responseStatus ?? null,
    incompleteReason: outcome.incompleteReason,
    usage: outcome.usage,
    inconclusive: liveness.inconclusive.map((o) => ({
      name: o.provider.provider.name,
      catalog_url: o.provider.provider.catalog_url,
      httpStatus: o.httpStatus,
      detail: o.detail,
    })),
    dead: liveness.dead.map((d) => ({
      name: d.provider.provider.name,
      catalog_url: d.provider.provider.catalog_url,
      httpStatus: d.httpStatus,
      detail: d.detail,
    })),
    completedAt: new Date().toISOString(),
  }

  return { rows, counts, metadata }
}
