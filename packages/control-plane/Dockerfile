FROM node:22-alpine AS base

# Install dependencies only when needed
FROM base AS deps
WORKDIR /app

# Copy root package files for workspace resolution
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/control-plane/package.json packages/control-plane/

RUN npm ci --workspace=@open-inspect/control-plane

# Build the shared package first, then control plane
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/control-plane/node_modules ./packages/control-plane/node_modules
COPY package.json ./
COPY packages/shared/ packages/shared/
COPY packages/control-plane/ packages/control-plane/

RUN npm run build -w @open-inspect/shared
RUN npm run build -w @open-inspect/control-plane

# Production image
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

# Copy built artifacts
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/control-plane/dist ./packages/control-plane/dist
COPY --from=builder /app/packages/control-plane/package.json ./packages/control-plane/
COPY --from=builder /app/package.json ./

EXPOSE 3001

CMD ["node", "packages/control-plane/dist/index.js"]
