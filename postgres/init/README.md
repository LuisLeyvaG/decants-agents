# postgres/init

Schema SQL del Postgres del sistema agéntico (`postgres-agents`).

## Convención de nombres

Archivos numerados en orden de aplicación. El container `postgres:15-alpine`
ejecuta automáticamente todo `.sql` dentro de `docker-entrypoint-initdb.d`
**solo en el primer arranque** (cuando el named volume `postgres-agents-data`
está vacío).

| Archivo | Contenido |
|---|---|
| `00-extensions.sql` | `CREATE EXTENSION pg_trgm` |
| `01-schema.sql` | Schema `agent` + 4 tablas iniciales (Fase 4) |
| `02-unknown-brand-candidates.sql` | Tabla del discovery loop del Agente 1 (Fase 5.3.4) |
| `03-trend-signals-add-fields.sql` | `brand_line` + `reasoning_summary` + `bucket` en `trend_signals` (Fase 5.3.4) |

## Aplicar migrations posteriores

Cuando se agrega un archivo nuevo (ej. `02-*.sql`) y el container ya está
corriendo en la VM con data persistida, el archivo nuevo NO se aplica
automáticamente. Hay que ejecutarlo manualmente.

Procedimiento desde la VM (con el container `postgres-agents` corriendo):

```bash
# Verificar que el archivo es idempotente leyéndolo primero.
cat ~/agents/postgres/init/02-unknown-brand-candidates.sql

# Aplicar contra la DB.
docker exec -i postgres-agents \
  psql -U "${POSTGRES_USER:-agents}" -d "${POSTGRES_DB:-agents}" \
  < ~/agents/postgres/init/02-unknown-brand-candidates.sql

# Verificar que la tabla nueva existe.
docker exec postgres-agents \
  psql -U "${POSTGRES_USER:-agents}" -d "${POSTGRES_DB:-agents}" \
  -c '\dt agent.*'
```

Los archivos deben ser idempotentes (`CREATE TABLE IF NOT EXISTS`, etc.)
para que re-aplicarlos no falle.

## Reset destructivo (solo dev / debug)

Para forzar re-ejecución completa del schema desde cero, hay que destruir
el named volume — esto borra TODA la data:

```bash
docker stop postgres-agents
docker volume rm decants-agents_postgres-agents-data
bash scripts/up.sh   # próximo arranque re-aplica todo init/
```

**Nunca hacer esto en producción.**
