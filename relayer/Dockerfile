FROM node:18 AS builder
WORKDIR /app

# Copy package files and install (including dev deps for build)
COPY relayer/package.json relayer/package-lock.json* ./
RUN npm ci --legacy-peer-deps

# Copy relayer source and build
COPY relayer/ ./
RUN npm run build

FROM node:18-alpine AS runner
WORKDIR /app

# Install only production dependencies
COPY relayer/package.json ./
RUN npm ci --only=production --legacy-peer-deps

# Copy built artifacts
COPY --from=builder /app/dist ./dist

EXPOSE 4001
ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
