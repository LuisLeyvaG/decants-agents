-- =====================================================================
-- 05-site-recipes.sql
--
-- Crea agent.site_recipes (Agente 3, Site Profiler): UNA receta de
-- scraping por proveedor — cómo leer ESE sitio en particular (cómo buscar
-- un perfume, dónde está precio/stock/tamaño/título). A3 la produce con
-- LLM al descubrir un proveedor nuevo o cuando A4 marca la receta `stale`;
-- A4 la EJECUTA en su scraping diario (sin LLM en el camino crítico).
--
-- Diseñado contra el `\d agent.providers` / `\d agent.stock_snapshots`
-- REALES (verificados antes de migrar — principio #4), no contra un
-- handoff. NO edita 01-schema.sql ni 04-providers-web-discovery-v3.sql.
--
-- Convenciones calcadas del schema `agent` existente:
--   * id        : text PRIMARY KEY, ULID generado client-side por A3 — SIN
--                 default server-side (igual que providers.id / stock_snapshots.id).
--   * provider_id: FK a providers calcada VERBATIM de stock_snapshots
--                 (REFERENCES agent.providers(id) ON DELETE CASCADE). El
--                 UNIQUE encima implementa "1 receta por proveedor".
--   * selectors : jsonb NOT NULL DEFAULT '{}' — misma red de seguridad de
--                 tipo que providers.evidence_urls: el DEFAULT mantiene la
--                 columna no-nullable, NO es permiso de entrar sin receta.
--                 La validez de una receta la lleva `recipe_status`, no un
--                 null en selectors.
--   * updated_at: trigger que REUTILIZA agent.set_updated_at() (definida en
--                 01-schema.sql) — no se redefine la función, solo el trigger,
--                 con el mismo patrón DROP+CREATE que providers_set_updated_at.
--
-- Idempotente (CREATE TABLE IF NOT EXISTS, DROP TRIGGER IF EXISTS).
-- Aplicar manualmente via psql, igual que 03 y 04.
--
-- ---------------------------------------------------------------------
-- -- DOWN (rollback manual, NO automatizado):
-- --   DROP TRIGGER IF EXISTS site_recipes_set_updated_at ON agent.site_recipes;
-- --   DROP TABLE  IF EXISTS agent.site_recipes;   -- (el UNIQUE, el CHECK y la
-- --                                                  FK caen con la tabla)
-- =====================================================================

SET search_path TO agent, public;

CREATE TABLE IF NOT EXISTS agent.site_recipes (
    id                  text PRIMARY KEY,
    -- 1 receta por proveedor: UNIQUE + FK calcada de stock_snapshots.
    provider_id         text NOT NULL UNIQUE
                          REFERENCES agent.providers(id) ON DELETE CASCADE,
    -- Cómo construir una búsqueda en el sitio (ej. '?s=<query>'). Nullable:
    -- no todo storefront tiene patrón de búsqueda navegable.
    search_url_template text,
    -- Selectores precio/stock/tamaño/título. DEFAULT '{}' = red de seguridad
    -- de tipo (ver cabecera), NO permiso de receta vacía.
    selectors           jsonb NOT NULL DEFAULT '{}',
    recipe_status       text  NOT NULL
                          CHECK (recipe_status IN ('active','stale','failed')),
    -- null hasta el primer perfilado exitoso.
    last_profiled_at    timestamptz,
    -- Traza de qué run de A3 produjo la receta (como run_id en otras tablas).
    profiler_run_id     text NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- updated_at autoupdate: REUTILIZA agent.set_updated_at() (01-schema.sql).
-- Mismo patrón DROP+CREATE que providers_set_updated_at (CREATE TRIGGER no
-- soporta IF NOT EXISTS).
DROP TRIGGER IF EXISTS site_recipes_set_updated_at ON agent.site_recipes;
CREATE TRIGGER site_recipes_set_updated_at
    BEFORE UPDATE ON agent.site_recipes
    FOR EACH ROW
    EXECUTE FUNCTION agent.set_updated_at();

-- Sin índices extra: el lookup de A4 por proveedor ya lo sirve el índice
-- implícito del UNIQUE(provider_id), y la tabla es ~1 fila por proveedor.
-- Si A3/A4 llegan a barrer recetas por estado a volumen ('stale'/'failed'
-- para re-perfilar), considerar entonces:
--   CREATE INDEX IF NOT EXISTS site_recipes_status_idx
--     ON agent.site_recipes (recipe_status);
-- No se agrega ahora (no lo justifica el volumen actual).
