/**
 * Open-Inspect Control Plane
 *
 * Hono HTTP server entry point with Rivet Actors for session management.
 *
 * Replaces the Cloudflare Workers entry point. Runs as a standard
 * Node.js HTTP server.
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config";
import { createLogger, parseLogLevel } from "./logger";
import { createRouter, type AppContext } from "./router";
import { getPool, closePool, SessionIndexStore, RepoMetadataStore, RepoSecretsStore } from "./db/postgres";
import { runMigrations } from "./db/migrations";
import { getRedis, closeRedis, RedisCache } from "./cache/redis";
import { registry } from "./actors/registry";

const log = createLogger("server");

async function main() {
  // Load configuration from process.env
  const config = loadConfig();
  log.info("Starting control plane", {
    port: config.port,
    deployment: config.deploymentName,
    logLevel: config.logLevel,
  });

  // Initialize PostgreSQL
  const pool = getPool(config.databaseUrl);
  await runMigrations(pool);

  // Initialize Redis
  const redis = getRedis(config.redisUrl);
  const cache = new RedisCache(redis);

  // Initialize data stores
  const sessionIndex = new SessionIndexStore(pool);
  const repoMetadata = new RepoMetadataStore(pool);
  const repoSecrets = new RepoSecretsStore(
    pool,
    config.repoSecretsEncryptionKey ?? config.tokenEncryptionKey,
  );

  // Build application context
  const appContext: AppContext = {
    config,
    sessionIndex,
    repoMetadata,
    repoSecrets,
    cache,
    registry,
  };

  // Create the main Hono app
  const app = new Hono();

  // Mount the API router
  const apiRouter = createRouter(appContext);
  app.route("/", apiRouter);

  // Mount Rivet actor handler for WebSocket connections and RPC
  // Rivet actors handle their own routing under /api/rivet/*
  app.all("/api/rivet/*", async (c) => {
    return await registry.handler(c.req.raw);
  });

  // Global error handler
  app.onError((err, c) => {
    log.error("Unhandled error", { error: err });
    return c.json(
      { error: "Internal server error" },
      500,
    );
  });

  // Start the HTTP server
  const server = serve({
    fetch: app.fetch,
    port: config.port,
  });

  log.info("Control plane started", {
    port: config.port,
    deployment: config.deploymentName,
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info("Shutting down", { signal });
    try {
      await closeRedis();
      await closePool();
      log.info("Graceful shutdown complete");
      process.exit(0);
    } catch (err) {
      log.error("Shutdown error", { error: err instanceof Error ? err : String(err) });
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  log.error("Fatal startup error", { error: err instanceof Error ? err : String(err) });
  process.exit(1);
});
