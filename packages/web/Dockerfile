# Stage 1: Install dependencies
FROM node:22-alpine AS deps
WORKDIR /app

# Copy package files for workspace setup
COPY package*.json ./
COPY packages/shared/package*.json ./packages/shared/
COPY packages/web/package*.json ./packages/web/

# Install dependencies
RUN npm ci

# Stage 2: Build the application
FROM node:22-alpine AS builder
WORKDIR /app

# Build-time environment variables (NEXT_PUBLIC_* must be set at build time)
ARG NEXT_PUBLIC_WS_URL
ENV NEXT_PUBLIC_WS_URL=${NEXT_PUBLIC_WS_URL}

ARG NEXT_PUBLIC_SCM_PROVIDER=github
ENV NEXT_PUBLIC_SCM_PROVIDER=${NEXT_PUBLIC_SCM_PROVIDER}

# Copy node_modules from deps stage (npm workspaces hoists to root)
COPY --from=deps /app/node_modules ./node_modules

# Copy source files
COPY package*.json ./
COPY packages/shared ./packages/shared
COPY packages/web ./packages/web

# Build shared package first, then web
RUN npm run build -w @cm-inspect/shared
RUN npm run build -w @open-inspect/web

# Stage 3: Production runner
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy standalone build output
COPY --from=builder /app/packages/web/.next/standalone ./
COPY --from=builder /app/packages/web/.next/static ./packages/web/.next/static
# Note: No public folder in this project

# Set ownership
RUN chown -R nextjs:nodejs /app

USER nextjs

EXPOSE 8080

ENV HOSTNAME="0.0.0.0"

CMD ["node", "packages/web/server.js"]
