# TODO

## Inmediato (post-deploy inicial)

- [ ] Correr `setup.sh` en la VM y verificar que los 3 secretos nuevos
      aparecen en Secret Manager (`gcloud secrets list --project=leyva-scents`).
- [ ] `up.sh` + `healthcheck.sh` retornan 0.
- [ ] Verificar que `psql` desde un container efímero en `leyvascents-net`
      conecta a `postgres-agents:5432` con las creds del Secret Manager.
- [ ] Hit a browserless desde otro container en la red:
      `curl http://browserless:3000/json/version?token=$TOKEN`.

## Wiring n8n → containers

- [ ] Credential `postgres-agents` en n8n apuntando a `postgres-agents:5432`,
      DB `agents`, schema search path `agent, public`.
- [ ] Credential `browserless-token` en n8n (HTTP Header Auth).
- [ ] Nodo HTTP Request de prueba en n8n: `GET browserless:3000/content?token=…&url=https://example.com`.

## Smoke tests por agente

- [ ] Agente 1 inserta una `trend_signals` ficticia y la lee de vuelta.
- [ ] Agente 2 inserta un `providers` con `dedup_hash` y comprueba
      que un segundo insert con mismo hash falla por UNIQUE.
- [ ] Agente 3 inserta un `stock_snapshots` referenciando un `providers.id`
      válido; verifica ON DELETE CASCADE.
- [ ] Los 3 escriben en `run_logs` con el mismo `run_id`.

## Runbook (pendiente de escribir)

- [ ] Cómo rotar `leyvascents-postgres-agents-password` sin tirar data.
- [ ] Cómo backupear el named volume `postgres-agents-data` (pg_dump cron
      a un bucket GCS es probablemente más simple que snapshots del volume).
- [ ] Cómo upgradar la imagen de browserless (canary primero en un
      compose alternativo).
- [ ] Qué hacer si Bright Data rota credenciales (refresh del .env
      desde Secret Manager + `up.sh` re-apply).

## Mejoras opcionales

- [ ] Métricas: postgres_exporter + scrape desde el Prometheus si existe.
- [ ] Quota de disco para el named volume `postgres-agents-data`
      (alertar si `docker system df` reporta > 15GB en volumes).
- [ ] Rate limiting en browserless (workers vs CONCURRENT).
