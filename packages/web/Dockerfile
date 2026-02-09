FROM node:22-alpine AS base

# Install dependencies
FROM base AS deps
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/web/package.json packages/web/

RUN npm ci --workspace=@open-inspect/web

# Build the shared package and web app
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/web/node_modules ./packages/web/node_modules
COPY package.json ./
COPY packages/shared/ packages/shared/
COPY packages/web/ packages/web/

RUN npm run build -w @open-inspect/shared
RUN npm run build -w @open-inspect/web

# Production image using Next.js standalone output
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy Next.js standalone output
COPY --from=builder /app/packages/web/.next/standalone ./
COPY --from=builder /app/packages/web/.next/static ./packages/web/.next/static
COPY --from=builder /app/packages/web/public ./packages/web/public

USER nextjs

EXPOSE 3000

CMD ["node", "packages/web/server.js"]
