/**
 * persistence — the Postgres layer for Agente 2's container: upsert accepted+
 * alive providers into `agent.providers`, and close the `agent.run_logs` row that
 * n8n opened for this run.
 *
 * Connection: the full connection string comes from Secret Manager
 * (leyvascents-agents-postgres-url) and points at `postgres-agents:5432` over the
 * `leyvascents-net` Docker network. Tables are FULLY QUALIFIED (`agent.providers`,
 * `agent.run_logs`) so the layer never depends on a search_path — same convention
 * as A1's n8n SQL nodes.
 *
 * The schema this targets is the v3 web-discovery shape (postgres/init/
 * 04-providers-web-discovery-v3.sql), verified column-by-column at design time:
 *   id, source, source_id, name, catalog_url, whatsapp, instagram_handle,
 *   evidence_urls (text[]), discovery_query, confidence, trust_quality,
 *   trust_fulfillment (nullable), last_verified_at (nullable), status, dedup_hash
 *   (UNIQUE providers_dedup_hash_key), run_id, created_at, updated_at (trigger).
 */

import pg from 'pg'
import type { Pool as PgPool, PoolClient } from 'pg'

import type { Provider } from '../schemas/provider.schema.js'

const { Pool } = pg

/** A complete DB row: the parsed Provider plus the two system identifiers A2 stamps. */
export type ProviderRow = Provider & { readonly id: string; readonly run_id: string }

/** Counts the succeeded-close records for the run trace. */
export interface RunCounts {
  readonly emitted: number
  readonly accepted: number
  readonly dead: number
  readonly duplicates: number
  readonly written: number
  readonly rejected: number
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

/**
 * One pool per process, created at startup from the Secret Manager URL. The pool
 * is small: this container handles one weekly run, serially. We cap it so a stuck
 * connection cannot pin the DB.
 */
export function createPool(connectionString: string): PgPool {
  return new Pool({
    connectionString,
    max: 4,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  })
}

// ---------------------------------------------------------------------------
// Upsert
// ---------------------------------------------------------------------------

/**
 * Upsert ONE provider on the dedup_hash unique key.
 *
 * INSERT: a brand-new provider enters with everything A2 produced.
 *
 * ON CONFLICT (dedup_hash) DO UPDATE: a provider we have seen before gets its
 * DISCOVERY data refreshed (name / contacts / evidence / scores / discovery_query
 * / run_id). It deliberately does NOT touch:
 *   - `status`            — owned by the provider's lifecycle (A3/A4 may have set
 *                           it inactive/suspended). Refreshing data is NOT the same
 *                           as reviving status; A2 keeps the evidence current so A3
 *                           CAN reactivate, but never reactivates on its own.
 *   - `trust_fulfillment` / `last_verified_at` — owned by A4; A2 emits null for
 *                           both and must never clobber A4's measurements with null.
 *   - `id` / `created_at` — identity / birth time, immutable on update.
 *
 * NOTE — refresh is UNCONDITIONAL: there is intentionally NO `WHERE status =
 * 'active'` guard on the UPDATE. A suspended/inactive provider still gets fresh
 * evidence; only its status is left untouched.
 */
async function upsertProvider(client: PoolClient, row: ProviderRow): Promise<void> {
  await client.query(
    `INSERT INTO agent.providers (
       id, source, source_id, name, catalog_url, whatsapp, instagram_handle,
       evidence_urls, discovery_query, confidence, trust_quality,
       trust_fulfillment, last_verified_at, status, dedup_hash, run_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11,
       $12, $13, $14, $15, $16
     )
     ON CONFLICT (dedup_hash) DO UPDATE SET
       source          = EXCLUDED.source,
       source_id       = EXCLUDED.source_id,
       name            = EXCLUDED.name,
       catalog_url     = EXCLUDED.catalog_url,
       whatsapp        = EXCLUDED.whatsapp,
       instagram_handle= EXCLUDED.instagram_handle,
       evidence_urls   = EXCLUDED.evidence_urls,
       discovery_query = EXCLUDED.discovery_query,
       confidence      = EXCLUDED.confidence,
       trust_quality   = EXCLUDED.trust_quality,
       run_id          = EXCLUDED.run_id`,
    [
      row.id,
      row.source,
      row.source_id,
      row.name,
      row.catalog_url,
      row.whatsapp,
      row.instagram_handle,
      row.evidence_urls, // node-pg maps a JS string[] to a Postgres text[]
      row.discovery_query,
      row.confidence,
      row.trust_quality,
      row.trust_fulfillment, // null from A2
      row.last_verified_at, // null from A2
      row.status,
      row.dedup_hash,
      row.run_id,
    ],
  )
}

// ---------------------------------------------------------------------------
// Commit / fail the run
// ---------------------------------------------------------------------------

/**
 * Persist the alive providers AND close run_logs 'succeeded' in ONE transaction:
 * either the whole write lands or nothing does (no providers without a closed
 * log, no closed log without its providers). Returns the count actually written.
 *
 * The run_logs close mirrors A1's node: it matches `WHERE run_id = $1 AND status
 * = 'started'`, so it is a no-op if the row was already closed — making it safe
 * against the n8n failure-branch backstop double-closing the same run.
 */
export async function commitRun(
  pool: PgPool,
  runId: string,
  rows: ReadonlyArray<ProviderRow>,
  counts: RunCounts,
  metadata: Record<string, unknown>,
): Promise<number> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const row of rows) {
      await upsertProvider(client, row)
    }
    await client.query(
      `UPDATE agent.run_logs
         SET status = 'succeeded',
             finished_at = now(),
             duration_ms = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int,
             signals_processed = $2::int,
             metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb
       WHERE run_id = $1 AND status = 'started'`,
      [runId, counts.written, JSON.stringify({ counts, ...metadata })],
    )
    await client.query('COMMIT')
    return rows.length
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/**
 * Close run_logs 'failed' for a run that threw before/while persisting. Runs in
 * its OWN connection (not the rolled-back transaction) so the failure record
 * always lands. Idempotent via the same `status = 'started'` guard, so if n8n's
 * backstop also fires, the second UPDATE matches nothing.
 *
 * Never throws on its own DB error — it logs and swallows, because this is the
 * error path and the original error is what matters to the caller.
 */
export async function failRun(
  pool: PgPool,
  runId: string,
  errorMessage: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await pool.query(
      `UPDATE agent.run_logs
         SET status = 'failed',
             finished_at = now(),
             duration_ms = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int,
             errors_count = 1,
             metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
       WHERE run_id = $1 AND status = 'started'`,
      [runId, JSON.stringify({ error: errorMessage, ...metadata })],
    )
  } catch (e) {
    // Last-resort: the run already failed; a failed close is logged, not thrown.
    console.error(`[persistence] could not close run_logs failed for ${runId}: ${(e as Error).message}`)
  }
}
