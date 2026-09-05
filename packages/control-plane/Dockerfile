# syntax=docker/dockerfile:1
#
# The control plane as a container: the Node host (src/node/main.ts) bundled
# by `build:node`, the D1 migrations it applies at boot, and the litestream
# binary the entrypoint uses to restore the global store from a replica.
#
# Build from the repository root so the shared package and the migrations
# are in the context:
#   docker build -f packages/control-plane/Dockerfile -t open-inspect-control-plane .

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/control-plane/package.json packages/control-plane/
# --ignore-scripts: the root package's prepare script installs git hooks
# through husky, which a workspace-scoped install does not bring along.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --workspace=@open-inspect/shared --workspace=@open-inspect/control-plane
COPY packages/shared/ packages/shared/
COPY packages/control-plane/ packages/control-plane/
# Contracts the control plane shares with the sandbox runtime, imported by path.
COPY packages/sandbox-runtime/src/sandbox_runtime/*.json packages/sandbox-runtime/src/sandbox_runtime/
RUN npm run build -w @open-inspect/shared \
    && npm run build:node -w @open-inspect/control-plane

FROM litestream/litestream:0.3.13 AS litestream

FROM node:22-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data
# The bundle and the migrations sit where they sit in the repository, so the
# host's default migrations path resolves without MIGRATIONS_DIR being set.
WORKDIR /app
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY --from=build /app/packages/control-plane/dist/node/main.js packages/control-plane/dist/node/main.js
COPY terraform/d1/migrations/ terraform/d1/migrations/
COPY --chmod=755 packages/control-plane/docker/entrypoint.sh /app/entrypoint.sh
COPY packages/control-plane/docker/litestream.yml /etc/litestream.yml
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "/app/packages/control-plane/dist/node/main.js"]
