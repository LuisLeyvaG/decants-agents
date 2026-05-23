-- Schema `agent` para el sistema agéntico de inventario.
-- ULIDs se generan client-side por los agentes (no hay default server-side).

CREATE SCHEMA IF NOT EXISTS agent;

SET search_path TO agent, public;

-- ---------------------------------------------------------------------------
-- 1. trend_signals — Agente 1 (Trend Analyst)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent.trend_signals (
    id               text PRIMARY KEY,
    brand            text NOT NULL,
    fragrance_name   text NOT NULL,
    demand_score     int  NOT NULL CHECK (demand_score BETWEEN 0 AND 100),
    velocity_7d      numeric,
    sentiment        text NOT NULL CHECK (sentiment IN ('positive','mixed','hype_only')),
    sources          text[],
    evidence_quotes  text[],
    confidence       numeric NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    run_id           text NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (brand, fragrance_name, run_id)
);

CREATE INDEX IF NOT EXISTS trend_signals_created_at_desc_idx
    ON agent.trend_signals (created_at DESC);

CREATE INDEX IF NOT EXISTS trend_signals_high_demand_idx
    ON agent.trend_signals (demand_score DESC)
    WHERE demand_score >= 60;

-- ---------------------------------------------------------------------------
-- 2. providers — Agente 2 (Sourcing Scout)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent.providers (
    id                        text PRIMARY KEY,
    source                    text NOT NULL CHECK (source IN ('maps','mercadolibre','instagram')),
    source_id                 text,
    name                      text NOT NULL,
    whatsapp                  text,
    instagram_handle          text,
    reputation_score          numeric CHECK (reputation_score BETWEEN 0 AND 1),
    brand_overlap_score       numeric CHECK (brand_overlap_score BETWEEN 0 AND 1),
    response_speed_score      numeric CHECK (response_speed_score BETWEEN 0 AND 1),
    physical_presence_score   numeric CHECK (physical_presence_score BETWEEN 0 AND 1),
    refund_policy_score       numeric CHECK (refund_policy_score BETWEEN 0 AND 1),
    composite_score           numeric CHECK (composite_score BETWEEN 0 AND 1),
    tier                      int CHECK (tier IN (1,2,3)),
    avg_whatsapp_ms           int,
    last_verified_at          timestamptz,
    status                    text NOT NULL CHECK (status IN ('active','inactive','suspended')),
    catalog_url               text,
    dedup_hash                text NOT NULL,
    run_id                    text NOT NULL,
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),
    UNIQUE (dedup_hash)
);

CREATE INDEX IF NOT EXISTS providers_active_ranking_idx
    ON agent.providers (tier, status, composite_score DESC)
    WHERE status = 'active';

-- updated_at autoupdate trigger
CREATE OR REPLACE FUNCTION agent.set_updated_at()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS providers_set_updated_at ON agent.providers;
CREATE TRIGGER providers_set_updated_at
    BEFORE UPDATE ON agent.providers
    FOR EACH ROW
    EXECUTE FUNCTION agent.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. stock_snapshots — Agente 3 (Availability Matcher)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent.stock_snapshots (
    id                 text PRIMARY KEY,
    provider_id        text NOT NULL REFERENCES agent.providers(id) ON DELETE CASCADE,
    sku                text NOT NULL,
    ml                 int  NOT NULL,
    has_stock          boolean NOT NULL,
    price_mxn          numeric,
    currency           text NOT NULL DEFAULT 'MXN',
    last_verified_at   timestamptz NOT NULL DEFAULT now(),
    run_id             text NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stock_snapshots_sku_ml_verified_idx
    ON agent.stock_snapshots (sku, ml, last_verified_at DESC);

CREATE INDEX IF NOT EXISTS stock_snapshots_provider_created_idx
    ON agent.stock_snapshots (provider_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4. run_logs — los 3 agentes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent.run_logs (
    id                  text PRIMARY KEY,
    run_id              text NOT NULL,
    agent               text NOT NULL CHECK (agent IN ('trend_analyst','sourcing_scout','availability_matcher')),
    status              text NOT NULL CHECK (status IN ('started','succeeded','failed','partial')),
    started_at          timestamptz NOT NULL DEFAULT now(),
    finished_at         timestamptz,
    duration_ms         int,
    signals_processed   int,
    errors_count        int NOT NULL DEFAULT 0,
    metadata            jsonb
);

CREATE INDEX IF NOT EXISTS run_logs_run_id_idx
    ON agent.run_logs (run_id);

CREATE INDEX IF NOT EXISTS run_logs_agent_started_idx
    ON agent.run_logs (agent, started_at DESC);
