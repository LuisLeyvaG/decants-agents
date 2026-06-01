-- =====================================================================
-- 04-providers-web-discovery-v3.sql
--
-- Migra agent.providers del diseño viejo (scoring determinístico de 5
-- dimensiones, fuentes Maps/MercadoLibre/Instagram) al shape v3 de
-- descubrimiento de proveedores por LLM en la web abierta (Agente 2,
-- Sourcing Scout pivotado a gpt-5.4 + web_search + Structured Outputs).
--
-- Diseñado contra el `\d agent.providers` REAL (volumen recién
-- materializado, 0 filas), no contra 01-schema.sql. NO edita 01-schema.sql.
--
-- Cambios:
--   * source        : CHECK ('maps'|'mercadolibre'|'instagram') -> CHECK ('web').
--                     Es un CHECK, NO un ENUM -> drop+add del CHECK, sin
--                     cirugía de tipo.
--   * RETIRA        : las 5 dims de score + composite_score + tier +
--                     avg_whatsapp_ms (los CHECK de columna caen con la
--                     columna automáticamente).
--   * catalog_url   : ya existe nullable -> SET NOT NULL directo (0 filas,
--                     sin backfill).
--   * AGREGA        : evidence_urls text[] NOT NULL DEFAULT '{}', discovery_query
--                     text NOT NULL, confidence numeric[0,1] NOT NULL,
--                     trust_quality numeric[0,1] NOT NULL, trust_fulfillment
--                     numeric[0,1] NULLABLE sin default (NULL = "sin datos aún",
--                     != neutro medido; A6 debe poder distinguirlos al calibrar).
--   * CONSERVA      : id, name, whatsapp, instagram_handle, source_id (nullable),
--                     last_verified_at (nullable, la usa A4), status (+CHECK),
--                     dedup_hash (+UNIQUE providers_dedup_hash_key), run_id,
--                     timestamps, trigger providers_set_updated_at.
--   * Índice        : drop providers_active_ranking_idx (depende de tier/
--                     composite_score) -> recrea sobre (status, trust_quality DESC).
--
-- NOTA sobre evidence_urls: el DEFAULT '{}' es una RED DE SEGURIDAD DE TIPO
-- (mantiene la columna no-nullable, alineada con el Zod schema), NO un permiso
-- para entrar sin evidencia. El criterio de entrada sigue siendo duro: el
-- validateAndFilter del sprint 2R.3 DEBE rechazar evidence_urls vacío como regla
-- de negocio. Un array vacío que llega a la tabla es un bug aguas arriba, no un
-- estado válido.
--
-- Idempotente (IF EXISTS / IF NOT EXISTS / DO $$ pg_constraint). Aplicar
-- manualmente via psql, igual que 03-trend-signals-add-fields.sql.
--
-- ---------------------------------------------------------------------
-- -- DOWN (rollback manual, NO automatizado):
-- --   DROP INDEX IF EXISTS agent.providers_active_ranking_idx;
-- --
-- --   -- quitar columnas v3
-- --   ALTER TABLE agent.providers
-- --     DROP COLUMN IF EXISTS evidence_urls,
-- --     DROP COLUMN IF EXISTS discovery_query,
-- --     DROP COLUMN IF EXISTS confidence,
-- --     DROP COLUMN IF EXISTS trust_quality,
-- --     DROP COLUMN IF EXISTS trust_fulfillment;
-- --
-- --   -- catalog_url vuelve a nullable
-- --   ALTER TABLE agent.providers ALTER COLUMN catalog_url DROP NOT NULL;
-- --
-- --   -- restaurar source viejo
-- --   ALTER TABLE agent.providers DROP CONSTRAINT IF EXISTS providers_source_check;
-- --   ALTER TABLE agent.providers ADD CONSTRAINT providers_source_check
-- --     CHECK (source = ANY (ARRAY['maps','mercadolibre','instagram']));
-- --
-- --   -- re-agregar columnas viejas CON sus CHECK (no dejar el shape laxo):
-- --   ALTER TABLE agent.providers
-- --     ADD COLUMN reputation_score numeric,
-- --     ADD COLUMN brand_overlap_score numeric,
-- --     ADD COLUMN response_speed_score numeric,
-- --     ADD COLUMN physical_presence_score numeric,
-- --     ADD COLUMN refund_policy_score numeric,
-- --     ADD COLUMN composite_score numeric,
-- --     ADD COLUMN tier integer,
-- --     ADD COLUMN avg_whatsapp_ms integer;
-- --   ALTER TABLE agent.providers
-- --     ADD CONSTRAINT providers_reputation_score_check        CHECK (reputation_score        >= 0 AND reputation_score        <= 1),
-- --     ADD CONSTRAINT providers_brand_overlap_score_check     CHECK (brand_overlap_score     >= 0 AND brand_overlap_score     <= 1),
-- --     ADD CONSTRAINT providers_response_speed_score_check    CHECK (response_speed_score    >= 0 AND response_speed_score    <= 1),
-- --     ADD CONSTRAINT providers_physical_presence_score_check CHECK (physical_presence_score >= 0 AND physical_presence_score <= 1),
-- --     ADD CONSTRAINT providers_refund_policy_score_check     CHECK (refund_policy_score     >= 0 AND refund_policy_score     <= 1),
-- --     ADD CONSTRAINT providers_composite_score_check         CHECK (composite_score         >= 0 AND composite_score         <= 1),
-- --     ADD CONSTRAINT providers_tier_check                    CHECK (tier = ANY (ARRAY[1,2,3]));
-- --
-- --   -- restaurar el índice viejo
-- --   CREATE INDEX providers_active_ranking_idx
-- --     ON agent.providers (tier, status, composite_score DESC)
-- --     WHERE status = 'active';
-- =====================================================================

SET search_path TO agent, public;

-- 1. Índice dependiente de tier/composite_score: fuera antes de retirar columnas.
DROP INDEX IF EXISTS agent.providers_active_ranking_idx;

-- 2. source: reescribir el CHECK a 'web' (drop+add; es CHECK, no enum).
--    DROP dentro del bloque para que la idempotencia sea real (re-aplicar
--    cuando la constraint nueva ya existe es un no-op limpio).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'providers_source_check'
      AND pg_get_constraintdef(oid) = 'CHECK ((source = ''web''::text))'
  ) THEN
    ALTER TABLE agent.providers DROP CONSTRAINT IF EXISTS providers_source_check;
    ALTER TABLE agent.providers
      ADD CONSTRAINT providers_source_check CHECK (source IN ('web'));
  END IF;
END$$;

-- 3. Retirar el scoring determinístico muerto. Los CHECK de cada columna
--    (providers_<col>_check) caen automáticamente con la columna.
ALTER TABLE agent.providers
  DROP COLUMN IF EXISTS reputation_score,
  DROP COLUMN IF EXISTS brand_overlap_score,
  DROP COLUMN IF EXISTS response_speed_score,
  DROP COLUMN IF EXISTS physical_presence_score,
  DROP COLUMN IF EXISTS refund_policy_score,
  DROP COLUMN IF EXISTS composite_score,
  DROP COLUMN IF EXISTS tier,
  DROP COLUMN IF EXISTS avg_whatsapp_ms;

-- 4. catalog_url ya existe (nullable) -> endurecer a NOT NULL. 0 filas: directo.
ALTER TABLE agent.providers ALTER COLUMN catalog_url SET NOT NULL;

-- 5. Columnas nuevas del shape v3.
ALTER TABLE agent.providers
  ADD COLUMN IF NOT EXISTS evidence_urls     text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS discovery_query   text,
  ADD COLUMN IF NOT EXISTS confidence        numeric,
  ADD COLUMN IF NOT EXISTS trust_quality     numeric,
  ADD COLUMN IF NOT EXISTS trust_fulfillment numeric;   -- NULLABLE, sin default

-- 5b. NOT NULL para los campos que el modelo SIEMPRE produce (0 filas: directo).
--     Una inserción sin uno de ellos debe fallar ruidosamente, no entrar NULL.
--     trust_fulfillment se queda NULLABLE a propósito.
ALTER TABLE agent.providers ALTER COLUMN discovery_query SET NOT NULL;
ALTER TABLE agent.providers ALTER COLUMN confidence      SET NOT NULL;
ALTER TABLE agent.providers ALTER COLUMN trust_quality   SET NOT NULL;

-- 5c. CHECKs de rango [0,1] (espejo de trend_signals.confidence), idempotentes.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'providers_confidence_check') THEN
    ALTER TABLE agent.providers ADD CONSTRAINT providers_confidence_check
      CHECK (confidence >= 0 AND confidence <= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'providers_trust_quality_check') THEN
    ALTER TABLE agent.providers ADD CONSTRAINT providers_trust_quality_check
      CHECK (trust_quality >= 0 AND trust_quality <= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'providers_trust_fulfillment_check') THEN
    ALTER TABLE agent.providers ADD CONSTRAINT providers_trust_fulfillment_check
      CHECK (trust_fulfillment IS NULL OR (trust_fulfillment >= 0 AND trust_fulfillment <= 1));
  END IF;
END$$;

-- 6. Recrear el índice de ranking sobre la nueva señal de confianza.
CREATE INDEX IF NOT EXISTS providers_active_ranking_idx
  ON agent.providers (status, trust_quality DESC)
  WHERE status = 'active';
