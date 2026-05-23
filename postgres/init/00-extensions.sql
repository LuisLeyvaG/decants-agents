-- Extensiones requeridas. Corre PRIMERO por orden alfabético en
-- /docker-entrypoint-initdb.d/, antes de 01-schema.sql.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
