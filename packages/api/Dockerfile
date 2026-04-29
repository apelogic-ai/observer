# syntax=docker/dockerfile:1.6
#
# Observer API (ingestor) container image.
#
# Build context must be the **repo root** (workspace root) so we can copy
# the lockfile and install workspace dependencies. Build with:
#
#   docker build -f packages/api/Dockerfile -t observer-api .
#
# Two stages:
#   1. deps — install workspace deps (cached when neither lockfile nor
#      package.json files change).
#   2. runtime — minimal Bun image with the api source + node_modules.

# ── Stage 1: install workspace dependencies ───────────────────────
FROM oven/bun:1.2.21-alpine AS deps

WORKDIR /app

# Lockfile + each workspace package.json — copy first so changes to
# unrelated source files don't invalidate the dep cache.
COPY package.json bun.lock ./
COPY packages/api/package.json     packages/api/package.json
COPY packages/agent/package.json   packages/agent/package.json
COPY packages/dashboard/package.json packages/dashboard/package.json

RUN bun install --frozen-lockfile

# ── Stage 2: runtime ──────────────────────────────────────────────
FROM oven/bun:1.2.21-alpine AS runtime

WORKDIR /app

# Copy the resolved node_modules from deps stage. This includes the
# api's @aws-sdk/client-s3 — which the ingestor needs at runtime.
COPY --from=deps /app/node_modules /app/node_modules

# Bring in the api source. We don't copy the other workspace packages —
# the ingestor doesn't depend on agent or dashboard at runtime.
COPY packages/api/package.json /app/packages/api/package.json
COPY packages/api/src          /app/packages/api/src
COPY packages/api/tsconfig.json /app/packages/api/tsconfig.json

# Workspace metadata for bun's resolver.
COPY package.json /app/package.json

# Drop privileges. The bun image ships a `bun` user with uid 1000.
USER bun

EXPOSE 19900

# bun runs the TypeScript entry directly — no precompile step needed.
WORKDIR /app/packages/api
CMD ["bun", "src/main.ts"]
