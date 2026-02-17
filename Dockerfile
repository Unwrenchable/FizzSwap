# Multi-stage Dockerfile for FizzSwap monorepo
# Builds Node artifacts and packages the relayer for production runtime.

FROM node:18-bullseye AS builder
WORKDIR /app

# Copy package manifests first for better layer caching
COPY package.json package-lock.json* ./
COPY relayer/package.json relayer/package-lock.json* ./relayer/
COPY web/package.json web/package-lock.json* ./web/

# Install root deps (use legacy-peer-deps to avoid peer conflicts present in repo)
RUN npm ci --legacy-peer-deps --no-audit --no-fund

# Install relayer production deps only (cached from above COPY)
RUN npm --prefix relayer ci --legacy-peer-deps --omit=dev --no-audit --no-fund || true

# Copy the full repository
COPY . .

# Build arguments to allow skipping heavy steps (Hardhat compile / web build)
ARG SKIP_COMPILE=false
ARG SKIP_WEB_BUILD=false

# Build TypeScript (root) - safe to ignore failures in constrained environments
RUN if [ "$SKIP_COMPILE" = "false" ]; then npm run build || true; fi

# Optionally compile contracts (may require network access for solc downloads)
RUN if [ "$SKIP_COMPILE" = "false" ]; then npm run compile-contracts || true; fi

# Build relayer (TypeScript -> dist)
RUN npm --prefix relayer run build

# Optionally build the web UI
RUN if [ "$SKIP_WEB_BUILD" = "false" ]; then npm --prefix web ci --legacy-peer-deps --no-audit --no-fund && npm --prefix web run build; fi


FROM node:18-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Copy the relayer runtime (dist + production node_modules)
COPY --from=builder /app/relayer/dist ./relayer/dist
COPY --from=builder /app/relayer/package.json ./relayer/package.json
COPY --from=builder /app/relayer/node_modules ./relayer/node_modules
COPY --from=builder /app/relayer/init-mappings.js ./relayer/init-mappings.js
COPY --from=builder /app/relayer/docker-entrypoint.sh ./relayer/docker-entrypoint.sh

# Optional: include compiled root JS (if needed by server endpoints)
COPY --from=builder /app/dist ./dist

# Copy persisted mappings if present (will be created at runtime otherwise)
COPY --from=builder /app/relayer-mappings.json ./relayer-mappings.json

EXPOSE 4001

WORKDIR /app/relayer
RUN chmod +x ./docker-entrypoint.sh || true
ENTRYPOINT ["./docker-entrypoint.sh"]
