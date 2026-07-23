# syntax=docker/dockerfile:1
#
# Image for Agente 2 (Sourcing Scout) — the container that runs the REAL pipeline
# on the VM `leyvascents-n8n`, joined to the `leyvascents-net` Docker network
# alongside postgres-agents and browserless.
#
# Build context is the `workflows/` directory (NOT the repo root): the runtime
# imports reach across 02-sourcing-scout/ (validate-and-filter, liveness-check,
# schemas, scripts) and the build scripts live in workflows/scripts/.
#
#   docker build -f workflows/Dockerfile \
#     -t us-central1-docker.pkg.dev/leyva-scents/leyvascents/sourcing-scout:v1 \
#     workflows/
#
# Runtime executes TypeScript directly via tsx — IDENTICAL to how the 231 tests
# and the calibration smoke run, so there is zero module-resolution divergence
# between what was verified and what ships. (Compiling to plain JS is a future
# hardening step — see TODO.md.)

# ---- builder: install deps + materialize the build artifacts -------------------
FROM node:20-slim AS builder
WORKDIR /app

# Deps first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# Source, then materialize the two build artifacts:
#   - build:schema  → regenerates the SO JSON schema from the Zod contract
#                     (anti-drift: the image carries a schema that matches the code).
#   - build:prompt  → resolves {{REFERENCE_BRANDS_V3}} into system-prompt.generated.md
#                     (gitignored artifact; the container needs it baked in).
COPY . .
RUN npm run build:schema && npm run build:prompt

# ---- runtime: prod deps + source + baked artifacts -----------------------------
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Prod-only deps (tsx is a runtime dependency; the TS compiler is not needed).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# A2's runtime code + the build artifacts from the builder. A2 does NOT need
# 01-trend-analyst or workflows/scripts at runtime — only its own subtree, which
# already contains its scripts/ (dedup, brightdata-fetch→redactSecrets, cost-guard).
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/02-sourcing-scout ./02-sourcing-scout

EXPOSE 8080

# Liveness only (no DB round-trip) so a transient DB blip does not flap the
# container unhealthy. node:20 ships a global fetch().
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start:sourcing-scout"]
