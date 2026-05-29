-- =====================================================================
-- 02-unknown-brand-candidates.sql
--
-- Discovery loop for fragrance signals whose brand is not present in the
-- canonical taxonomy (workflows/01-trend-analyst/taxonomy.ts). Instead of
-- silently dropping them, the validate-and-filter Code node routes them
-- here so a human can decide whether to (a) promote the brand to the
-- canonical taxonomy, (b) reject as noise / spam, or (c) flag as duplicate
-- of an existing brand under a different spelling.
--
-- UPSERT semantics (handled in app code, not in this schema):
--   * If (brand, brand_line, fragrance_name) already exists with status
--     = 'pending', INCREMENT observed_count and update last_seen_at.
--   * If it exists with status != 'pending' (already reviewed), still
--     update last_seen_at but DO NOT change status or observed_count.
--   * Otherwise INSERT a new row with observed_count = 1.
--
-- This file is idempotent: re-applying it on a database that already has
-- the table is a no-op. Applied manually via psql when the postgres-agents
-- container is already running (see postgres/init/README.md).
-- =====================================================================

CREATE TABLE IF NOT EXISTS agent.unknown_brand_candidates (
  id text PRIMARY KEY,
  brand text NOT NULL,
  brand_line text,
  fragrance_name text NOT NULL,
  demand_score int CHECK (demand_score BETWEEN 0 AND 100),
  confidence numeric CHECK (confidence BETWEEN 0 AND 1),
  sentiment text CHECK (sentiment IN ('positive', 'mixed', 'hype_only')),
  evidence_quotes text[],
  reasoning_summary text,
  sources text[],
  run_id text NOT NULL,
  observed_count int NOT NULL DEFAULT 1 CHECK (observed_count >= 1),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'promoted', 'rejected', 'duplicate')),
  reviewed_at timestamptz,
  reviewer_notes text,
  UNIQUE (brand, brand_line, fragrance_name)
);

-- Pending queue, ordered by recency for human review UI.
CREATE INDEX IF NOT EXISTS unknown_brand_candidates_pending_idx
  ON agent.unknown_brand_candidates (last_seen_at DESC)
  WHERE status = 'pending';

-- Pending queue, ordered by observed_count for prioritized review.
-- A brand seen 10+ times in pending is a stronger candidate for promotion
-- than one seen once.
CREATE INDEX IF NOT EXISTS unknown_brand_candidates_pending_count_idx
  ON agent.unknown_brand_candidates (observed_count DESC)
  WHERE status = 'pending';

-- Trace back to the originating run when investigating a candidate.
CREATE INDEX IF NOT EXISTS unknown_brand_candidates_run_id_idx
  ON agent.unknown_brand_candidates (run_id);
