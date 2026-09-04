/**
 * The Node host: one process that serves the control plane's routes, runs
 * session runtimes in a registry, and drives the scheduled jobs. It is the
 * Node counterpart of the Worker entrypoint (`src/index.ts`) and the
 * session Durable Object (`cloudflare/durable-object.ts`) together, over
 * the adapters in this directory.
 *
 * Boot order: the global store is opened and migrated, the alarm clock and
 * the registry are built, the environment is validated, and only then does
 * the server listen and the clock, sweeper, and cron start. Shutdown runs
 * the same in reverse within the configured budget: the health check
 * answers 503, the clocks stop, the server stops accepting, every runtime
 * is quiesced (sockets closed with 1012 so peers reconnect), background
 * work is drained, and the stores are closed.
 */

import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { SessionIndexStore } from "../db/session-index";
import type { SqlDatabase } from "../db/sql-database";
import { requireRepoSecretsEncryptionKey, requireTokenEncryptionKey } from "../env-validation";
import { createLogger, parseLogLevel, type Logger } from "../logger";
import { catalog } from "../routes/catalog";
import { createControlPlaneApp, type ControlPlaneHost } from "../routing/hono-app";
import { SCHEDULED_JOBS } from "../scheduled-jobs";
import { createSessionRuntime, type SessionRuntime } from "../session/components";
import { createSessionRuntimeClient } from "../session/runtime-client";
import type { Env, EnvConfig, Platform } from "../types";
import { createNodeBackgroundTasks } from "./background-tasks";
import type { NodeHostSettings } from "./config";
import { CronLoop } from "./cron-loop";
import { HostAlarmClock } from "./host-alarm-clock";
import { openHostAlarmIndex } from "./host-alarm-index";
import { createNodeHttpServer, type HealthReport } from "./http-server";
import { createMemoryCacheStore } from "./memory-cache-store";
import { ensurePrivateDirectory } from "./private-paths";
import { createNodeSessionRuntimeDispatch } from "./runtime-client";
import { createS3ObjectStorage, type S3ObjectStorageConfig } from "./s3-object-storage";
import { SessionRuntimeRegistry } from "./session-runtime-registry";
import { createFileSessionStoreProvider } from "./session-store";
import { openNodeSqlDatabase, type NodeSqlDatabase } from "./sqlite-database";
import { createSessionUpgradeHandler, MAX_MESSAGE_BYTES } from "./websocket-upgrade";

/** The global store's file inside the data directory. */
export const GLOBAL_STORE_FILE = "global.db";

export interface NodeHostOptions {
  config: EnvConfig;
  settings: NodeHostSettings;
  objectStorage: S3ObjectStorageConfig;
}

export interface NodeHost {
  /** Where the server is listening. */
  readonly address: AddressInfo;
  health(): HealthReport;
  /**
   * Stop serving, quiesce every runtime, wait for work within the
   * settings' budget, and close the stores. A second call joins the first.
   */
  shutdown(): Promise<void>;
}

export async function startNodeHost(options: NodeHostOptions): Promise<NodeHost> {
  const { config, settings } = options;
  const log = createLogger("node-host", {}, parseLogLevel(config.LOG_LEVEL));
  const startedAtMs = Date.now();

  ensurePrivateDirectory(settings.dataDir);
  const db = openNodeSqlDatabase(join(settings.dataDir, GLOBAL_STORE_FILE), {
    migrationsDir: settings.migrationsDir,
  });
  try {
    return await startWithGlobalStore(db, options, log, startedAtMs);
  } catch (error) {
    db.close();
    throw error;
  }
}

async function startWithGlobalStore(
  db: NodeSqlDatabase,
  options: NodeHostOptions,
  log: Logger,
  startedAtMs: number
): Promise<NodeHost> {
  const { config, settings } = options;
  const migrationsApplied = await countMigrations(db);

  const alarmIndex = openHostAlarmIndex(settings.dataDir);
  const clock: HostAlarmClock = new HostAlarmClock({
    index: alarmIndex,
    deliver: (sessionId) => registry.deliverScheduledDeadline(sessionId),
    log,
  });
  const registry: SessionRuntimeRegistry<SessionRuntime> = new SessionRuntimeRegistry({
    db,
    storeProvider: createFileSessionStoreProvider(settings.dataDir),
    sessionIndex: new SessionIndexStore(db),
    alarmStoreFor: (sessionId) => clock.storeFor(sessionId),
    buildRuntime: (platform) => createSessionRuntime(platform, env),
    log,
  });
  const platform: Platform = {
    DB: db,
    SESSION: createNodeSessionRuntimeDispatch(registry),
    REPOS_CACHE: createMemoryCacheStore(),
    MEDIA_BUCKET: createS3ObjectStorage(options.objectStorage),
  };
  const env: Env = { ...config, ...platform };
  // The same checks the Worker runs at first touch, run here before the
  // host can answer anything: a misconfigured key never serves a request.
  requireTokenEncryptionKey(env);
  requireRepoSecretsEncryptionKey(env);

  const processTasks = createNodeBackgroundTasks(log);
  const host: ControlPlaneHost = { backgroundTasks: () => processTasks };
  const app = createControlPlaneApp(catalog, host);
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const upgrade = createSessionUpgradeHandler({ db, runtimes: registry, log, webSocketServer });
  const cron = new CronLoop({
    jobs: SCHEDULED_JOBS,
    log,
    run: async (job, nowMs) => {
      const runId = crypto.randomUUID();
      const correlation = { trace_id: runId, request_id: runId };
      await job.run(
        {
          env,
          db,
          sessions: createSessionRuntimeClient(env, correlation),
          backgroundTasks: processTasks,
          log,
          correlation,
        },
        nowMs
      );
    },
  });

  let draining = false;
  let clocksRunning = false;
  const health = (): HealthReport => ({
    status: draining ? "draining" : "ok",
    uptime_s: Math.round((Date.now() - startedAtMs) / 1000),
    migrations_applied: migrationsApplied,
    sessions_resident: registry.residentSessionIds().length,
    background_tasks: processTasks.size,
    alarm_clock: clocksRunning ? "running" : "stopped",
    cron: clocksRunning ? "running" : "stopped",
  });
  const server = createNodeHttpServer({
    fetch: (request) => Promise.resolve(app.fetch(request, env)),
    upgrade,
    health,
  });

  try {
    server.listen(settings.port, settings.host);
    await once(server, "listening");
  } catch (error) {
    alarmIndex.close();
    throw error;
  }
  const address = server.address() as AddressInfo;
  clock.start();
  registry.startSweeper();
  cron.start();
  clocksRunning = true;
  log.info("node_host.listening", {
    event: "node_host.listening",
    host: address.address,
    port: address.port,
    data_dir: settings.dataDir,
    migrations_applied: migrationsApplied,
  });

  let stopping: Promise<void> | null = null;
  const shutdown = async (): Promise<void> => {
    draining = true;
    const deadlineMs = Date.now() + settings.shutdownTimeoutMs;
    log.info("node_host.draining", {
      event: "node_host.draining",
      timeout_ms: settings.shutdownTimeoutMs,
    });
    cron.stop();
    clock.stop();
    clocksRunning = false;
    // Stop accepting; idle keep-alive connections go now, requests in
    // flight finish, and whatever is still open at the end is cut.
    const closed = once(server, "close");
    server.close();
    server.closeIdleConnections();
    await registry.shutdown({ timeoutMs: remaining(deadlineMs) });
    await Promise.all([processTasks.drain(remaining(deadlineMs)), cron.drain(), clock.drain()]);
    server.closeAllConnections();
    await closed;
    webSocketServer.close();
    alarmIndex.close();
    db.close();
    log.info("node_host.stopped", { event: "node_host.stopped" });
  };

  return {
    address,
    health,
    shutdown: () => (stopping ??= shutdown()),
  };
}

function remaining(deadlineMs: number): number {
  return Math.max(0, deadlineMs - Date.now());
}

/** How many migrations the global store's ledger records, for the health report. */
async function countMigrations(db: SqlDatabase): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS applied FROM _schema_migrations")
    .first<{ applied: number }>();
  return row?.applied ?? 0;
}
