# Multi-stage Dockerfile for FizzSwap relayer backend.

FROM node:18-bullseye AS builder
WORKDIR /app

# Copy relayer manifests for better layer caching
COPY relayer/package.json relayer/package-lock.json* ./relayer/

# Install relayer production deps
RUN npm --prefix relayer ci --legacy-peer-deps --omit=dev --no-audit --no-fund

# Copy relayer source
COPY relayer/ ./relayer/

# Build relayer (TypeScript -> dist)
RUN npm --prefix relayer install --legacy-peer-deps --no-audit --no-fund && \
    npm --prefix relayer run build


FROM node:18-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Copy the relayer runtime
COPY --from=builder /app/relayer/dist ./relayer/dist
COPY --from=builder /app/relayer/package.json ./relayer/package.json
COPY --from=builder /app/relayer/node_modules ./relayer/node_modules
COPY --from=builder /app/relayer/init-mappings.js ./relayer/init-mappings.js
COPY --from=builder /app/relayer/docker-entrypoint.sh ./relayer/docker-entrypoint.sh

EXPOSE 4001

WORKDIR /app/relayer
RUN chmod +x ./docker-entrypoint.sh || true
ENTRYPOINT ["./docker-entrypoint.sh"]
