/**
 * Zod contract for Agente 2 (Sourcing Scout) — v3 web-discovery shape.
 *
 * A single `ProviderSchema` models a provider discovered by the LLM on the open
 * web (a decants store with its own website), emitted via gpt-5.4 + web_search +
 * Structured Outputs. It maps 1:1 to `agent.providers`
 * (postgres/init/01-schema.sql + 04-providers-web-discovery-v3.sql).
 *
 * The pre-v3 two-stage split (ProviderRaw -> scoreProvider -> ProviderScored) is
 * gone: deterministic 5-dimension scoring was retired with the Maps/ML/Instagram
 * sources. The model now emits the final record directly.
 *
 * As before, this EXCLUDES columns injected by the workflow Code node / DB and
 * never produced by the model:
 *   - `id`         — ULID generated client-side by the workflow Code node.
 *   - `run_id`     — the run identifier, injected per run.
 *   - `created_at` / `updated_at` — DB defaults / trigger-managed.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Enums (single source of truth — used by schema AND tests)
// ---------------------------------------------------------------------------

/** Allowed values for `source`. Mirrors the DB CHECK constraint. v3: web only. */
export const SOURCE_VALUES = ['web'] as const

/** Allowed values for `status`. Mirrors the DB CHECK constraint. */
export const STATUS_VALUES = ['active', 'inactive', 'suspended'] as const

const SourceSchema = z.enum(SOURCE_VALUES)
const StatusSchema = z.enum(STATUS_VALUES)

// ---------------------------------------------------------------------------
// ProviderSchema — the v3 record, maps 1:1 to agent.providers columns
// ---------------------------------------------------------------------------

export const ProviderSchema = z.object({
  source: SourceSchema.describe(
    'Discovery channel. Always "web" in v3. Mirrors agent.providers.source.',
  ),

  source_id: z
    .string()
    .min(1)
    .nullable()
    .describe(
      'Optional stable id from the discovery channel, kept for cheap traceability (A3/A4 may use it). NULL when none. Mirrors agent.providers.source_id.',
    ),

  name: z
    .string()
    .trim()
    .min(1)
    .describe('Provider / store display name. Mirrors agent.providers.name.'),

  catalog_url: z
    .string()
    .url()
    .describe(
      'URL of the provider catalog / storefront. Required (NOT NULL) in v3. Mirrors agent.providers.catalog_url.',
    ),

  whatsapp: z
    .string()
    .nullable()
    .describe(
      'Normalized phone: digits only, +52/52 prefix stripped. NULL when the site exposes no phone. Mirrors agent.providers.whatsapp.',
    ),

  instagram_handle: z
    .string()
    .nullable()
    .describe(
      'Instagram handle WITHOUT the leading "@". NULL when none. Mirrors agent.providers.instagram_handle.',
    ),

  evidence_urls: z
    .array(z.string().url())
    .describe(
      'Flat list of URLs justifying why this provider was admitted (catalog / about / policy pages). Mirrors agent.providers.evidence_urls (text[] NOT NULL DEFAULT \'{}\'). The DB default is a TYPE safety net only: an empty array is NOT a valid entry — validateAndFilter (sprint 2R.3) rejects empty evidence_urls as a hard rule.',
    ),

  discovery_query: z
    .string()
    .min(1)
    .describe(
      'The web_search query that surfaced this provider. Mirrors agent.providers.discovery_query.',
    ),

  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe(
      'Model confidence that this is a real, relevant decants provider, in [0,1]. Mirrors agent.providers.confidence.',
    ),

  trust_quality: z
    .number()
    .min(0)
    .max(1)
    .describe(
      'Product/catalog quality & legitimacy signal, in [0,1]. Mirrors agent.providers.trust_quality.',
    ),

  trust_fulfillment: z
    .number()
    .min(0)
    .max(1)
    .nullable()
    .describe(
      'Fulfillment-reliability signal, in [0,1]. NULL when no data yet (distinct from a measured neutral). Mirrors agent.providers.trust_fulfillment.',
    ),

  last_verified_at: z
    .string()
    .datetime({ offset: true })
    .nullable()
    .describe(
      'ISO-8601 timestamp of the last availability verification. NULL from A2 (A4 sets it). Mirrors agent.providers.last_verified_at.',
    ),

  status: StatusSchema.describe(
    'Lifecycle status. Defaults to "active". Mirrors agent.providers.status.',
  ),

  dedup_hash: z
    .string()
    .min(1)
    .describe(
      'Deterministic sha256 over the strongest identifier (tel > ig > dom). Backs the UNIQUE constraint on agent.providers.dedup_hash.',
    ),
})

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Source = (typeof SOURCE_VALUES)[number]
export type Status = (typeof STATUS_VALUES)[number]
export type Provider = z.infer<typeof ProviderSchema>
