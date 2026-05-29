-- =====================================================================
-- 03-trend-signals-add-fields.sql
--
-- Extend agent.trend_signals with three columns required by the agentic
-- system but missing from the original 01-schema.sql:
--
--   * brand_line       — premium line distinction within a brand, nullable
--                        (e.g. "Les Exclusifs" for Chanel, NULL for mainline).
--                        Mirrors the Zod TrendSignalSchema in
--                        workflows/01-trend-analyst/schemas/trend-signal.schema.ts.
--
--   * reasoning_summary — model's analytical synthesis distinct from
--                         evidence_quotes; 50-400 chars, NOT NULL.
--
--   * bucket           — canonical bucket resolved by the validate-and-filter
--                        Code node via lookup against taxonomy.ts. Valid
--                        values A-E only (F is "excluded" and never reaches
--                        this table).
--
-- Also updates the UNIQUE constraint to include brand_line, with NULLS NOT
-- DISTINCT semantics (PG15+) so that (Chanel, NULL, Bleu de Chanel, run-X)
-- and (Chanel, NULL, Bleu de Chanel, run-X) are correctly recognized as
-- the same tuple.
--
-- This file is idempotent: re-applying it is a no-op for existing columns
-- and constraints. Applied manually via psql.
-- =====================================================================

-- Add columns conditionally (IF NOT EXISTS is supported by PG 9.6+).
ALTER TABLE agent.trend_signals
  ADD COLUMN IF NOT EXISTS brand_line text;

ALTER TABLE agent.trend_signals
  ADD COLUMN IF NOT EXISTS reasoning_summary text;

ALTER TABLE agent.trend_signals
  ADD COLUMN IF NOT EXISTS bucket text;

-- CHECK constraint for reasoning_summary length bounds (matches Zod).
-- Wrapped in DO block for idempotency since CHECK constraints don't have
-- a built-in IF NOT EXISTS in older PG versions.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'trend_signals_reasoning_summary_length_check'
  ) THEN
    ALTER TABLE agent.trend_signals
      ADD CONSTRAINT trend_signals_reasoning_summary_length_check
      CHECK (
        reasoning_summary IS NULL
        OR (char_length(reasoning_summary) BETWEEN 50 AND 400)
      );
  END IF;
END$$;

-- CHECK constraint for bucket enum (A-E only; F never reaches this table).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'trend_signals_bucket_check'
  ) THEN
    ALTER TABLE agent.trend_signals
      ADD CONSTRAINT trend_signals_bucket_check
      CHECK (bucket IS NULL OR bucket IN ('A', 'B', 'C', 'D', 'E'));
  END IF;
END$$;

-- Update UNIQUE constraint to include brand_line with NULLS NOT DISTINCT.
-- This requires dropping and recreating because PG cannot ALTER UNIQUE
-- constraints in place.
ALTER TABLE agent.trend_signals
  DROP CONSTRAINT IF EXISTS trend_signals_brand_fragrance_name_run_id_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'trend_signals_brand_brand_line_fragrance_name_run_id_key'
  ) THEN
    ALTER TABLE agent.trend_signals
      ADD CONSTRAINT trend_signals_brand_brand_line_fragrance_name_run_id_key
      UNIQUE NULLS NOT DISTINCT (brand, brand_line, fragrance_name, run_id);
  END IF;
END$$;

-- Index on bucket for analytics queries ("how many Bucket A signals this week?").
CREATE INDEX IF NOT EXISTS trend_signals_bucket_idx
  ON agent.trend_signals (bucket, created_at DESC)
  WHERE bucket IS NOT NULL;