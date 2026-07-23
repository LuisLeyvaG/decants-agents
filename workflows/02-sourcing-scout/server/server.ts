/**
 * server — the HTTP surface of Agente 2's container. n8n orchestrates; this
 * container does the work.
 *
 *   POST /run  { run_id }  → run the full pipeline, upsert providers, CLOSE the
 *                            run_logs row n8n opened, respond
 *                            { run_id, counts: { emitted, accepted, dead,
 *                              duplicates, written, rejected } }.
 *   GET  /health           → 200 for Docker's healthcheck (liveness only — no DB
 *                            round-trip, so a transient DB blip does not flap the
 *                            container as unhealthy).
 *
 * run_id contract: n8n generates the ULID, INSERTs run_logs 'started', and passes
 * the SAME run_id here. This process closes that row 'succeeded' (in the commit
 * transaction) or 'failed' (on any throw). The audit trail is one run_id end to
 * end. If the container is unreachable and never gets here, n8n's own error
 * branch closes the row 'failed' — both use `WHERE status='started'`, so neither
 * double-closes.
 *
 * Built on node:http (no framework) — two trivial endpoints, matching the repo's
 * minimal-dependency style. Secrets, prompt, SO schema and the pg pool are loaded
 * ONCE at startup; a missing secret or bad prompt crashes the boot loudly rather
 * than failing the first run.
 *
 * Opsec: no secret value is ever logged. Error messages are surfaced only after
 * the OpenAI client has already redacted the API key from them.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import { loadSecrets } from './secrets.js'
import { createPool, commitRun, failRun } from './persistence.js'
import { loadPrompt, loadSoSchema, runPipeline } from './pipeline.js'

const PORT = Number(process.env.PORT ?? 8080)
const MAX_BODY_BYTES = 1_000_000 // 1 MB — bodies are a tiny { run_id } object

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(payload)
}

/** Read the request body with a hard size cap (reject oversized to avoid abuse). */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function main(): Promise<void> {
  // Startup: load everything once. Any failure here is fatal — exit non-zero so
  // Docker restarts and the operator sees the real cause (missing secret, bad
  // prompt, unreadable schema) instead of a half-up container.
  const secrets = await loadSecrets()
  const prompt = loadPrompt()
  const soSchema = loadSoSchema()
  const pool = createPool(secrets.postgresUrl)
  console.log(`[server] startup OK — prompt ${prompt.length} chars, SO schema "${soSchema.name}"`)

  // A2 is weekly + serial. Guard against an overlapping /run (e.g. an n8n retry)
  // launching a second paid OpenAI run and doubling the TPM reservation.
  let running = false

  const server = createServer((req, res) => {
    void (async () => {
      const { method, url } = req

      if (method === 'GET' && url === '/health') {
        sendJson(res, 200, { status: 'ok' })
        return
      }

      if (method !== 'POST' || url !== '/run') {
        sendJson(res, 404, { error: 'not found' })
        return
      }

      // --- POST /run ---
      let runId: string | undefined
      try {
        const raw = await readBody(req)
        const parsed = JSON.parse(raw) as { run_id?: unknown }
        if (typeof parsed.run_id !== 'string' || parsed.run_id.trim() === '') {
          // No valid run_id → we cannot close any run_logs row; reject without
          // touching the DB (n8n owns the row keyed by the run_id it generated).
          sendJson(res, 400, { error: 'body must be { run_id: <non-empty string> }' })
          return
        }
        runId = parsed.run_id.trim()
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' })
        return
      }

      if (running) {
        // Do NOT fail the run_logs row here: another in-flight run owns it.
        sendJson(res, 409, { run_id: runId, error: 'a run is already in progress' })
        return
      }

      running = true
      console.log(`[server] /run start — run_id=${runId}`)
      try {
        const { rows, counts, metadata } = await runPipeline({
          runId,
          openaiApiKey: secrets.openaiApiKey,
          prompt,
          soSchema,
        })
        await commitRun(pool, runId, rows, counts, metadata)
        console.log(`[server] /run done — run_id=${runId} counts=${JSON.stringify(counts)}`)
        sendJson(res, 200, { run_id: runId, counts })
      } catch (e) {
        const message = (e as Error).message
        console.error(`[server] /run failed — run_id=${runId}: ${message}`)
        // Close the run_logs row n8n opened so it never lingers as 'started'.
        await failRun(pool, runId, message)
        sendJson(res, 500, { run_id: runId, error: message })
      } finally {
        running = false
      }
    })().catch((e) => {
      // Last-resort guard: never leave a socket hanging on an unexpected throw.
      console.error(`[server] unhandled: ${(e as Error).message}`)
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
    })
  })

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] listening on 0.0.0.0:${PORT}`)
  })
}

void main().catch((err) => {
  console.error(`[server] fatal startup error: ${(err as Error).message}`)
  process.exit(1)
})
