/**
 * The Node host: one process that serves the control plane's routes, runs
 * session runtimes in a registry, and drives the scheduled jobs. It is the
 * Node counterpart of the Worker entrypoint (`src/index.ts`) and the
 * session Durable Object (`cloudflare/durable-object.ts`) together, over
 * the adapters in this directory.
 *
 * Boot: the configuration is validated before any file is touched, then
 * the global store is opened and migrated, the alarm clock and the
 * registry are built, the server listens, and the clock, sweeper, and
 * cron start. Everything acquired is released in reverse order if a later
 * step fails, and owned by the returned host once boot succeeds.
 *
 * Shutdown runs one deadline: the health check answers 503 and the clocks
 * stop, the server stops accepting, then everything that can still reach
 * a session runtime is drained under the budget (requests in flight,
 * scheduled runs, alarm deliveries, background tasks), then the registry
 * quiesces every runtime (sockets closed with 1012 so peers reconnect),
 * then the transports are closed, the peers that ignored the close are
 * cut, and the stores are closed. What outlived the budget is reported.
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
import {
  createControlPlaneApp,
  type ControlPlaneHost,
  type RouteModule,
} from "../routing/hono-app";
import { SCHEDULED_JOBS } from "../scheduled-jobs";
import { createSessionRuntime, type SessionRuntime } from "../session/components";
import { createSessionRuntimeClient } from "../session/runtime-client";
import type { Env, EnvConfig, Platform } from "../types";
import { createNodeBackgroundTasks, settlesWithin } from "./background-tasks";
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
import { openNodeSqlDatabase } from "./sqlite-database";
import { createSessionUpgradeHandler, MAX_MESSAGE_BYTES } from "./websocket-upgrade";

/** The global store's file inside the data directory. */
export const GLOBAL_STORE_FILE = "global.db";

export interface NodeHostOptions {
  config: EnvConfig;
  settings: NodeHostSettings;
  objectStorage: S3ObjectStorageConfig;
  /** The route modules to serve: the production catalog unless a test supplies its own. */
  routes?: readonly RouteModule[];
}

/** What a shutdown left running when its budget ran out. */
interface ShutdownReport {
  /** Every drain settled within the budget. */
  clean: boolean;
  /** The work abandoned at the deadline, by kind and count; empty when clean. */
  abandoned: string[];
}

export interface NodeHost {
  /** Where the server is listening. */
  readonly address: AddressInfo;
  health(): HealthReport;
  /**
   * Stop serving, drain and quiesce within the settings' budget, and close
   * the stores. A second call joins the first.
   */
  shutdown(): Promise<ShutdownReport>;
}

export async function startNodeHost(options: NodeHostOptions): Promise<NodeHost> {
  const { config } = options;
  const log = createLogger("node-host", {}, parseLogLevel(config.LOG_LEVEL));
  // The same checks the Worker runs at first touch, run before a file is
  // opened: a misconfigured key never serves a request and leaves nothing behind.
  requireTokenEncryptionKey(config);
  requireRepoSecretsEncryptionKey(config);

  // Everything acquired during boot, released in reverse if a later step fails.
  const acquired: Array<() => void> = [];
  try {
    return await boot(options, log, (release) => acquired.push(release));
  } catch (error) {
    for (const release of acquired.reverse()) {
      try {
        release();
      } catch (releaseError) {
        log.error("node_host.boot_release_failed", {
          event: "node_host.boot_release_failed",
          error: releaseError instanceof Error ? releaseError : String(releaseError),
        });
      }
    }
    throw error;
  }
}

async function boot(
  options: NodeHostOptions,
  log: Logger,
  acquire: (release: () => void) => void
): Promise<NodeHost> {
  const { config, settings } = options;
  const startedAtMs = Date.now();

  ensurePrivateDirectory(settings.dataDir);
  const db = openNodeSqlDatabase(join(settings.dataDir, GLOBAL_STORE_FILE), {
    migrationsDir: settings.migrationsDir,
  });
  acquire(() => db.close());
  const migrationsApplied = await countMigrations(db);

  const alarmIndex = openHostAlarmIndex(settings.dataDir);
  acquire(() => alarmIndex.close());
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

  const processTasks = createNodeBackgroundTasks(log);
  const host: ControlPlaneHost = { backgroundTasks: () => processTasks };
  const app = createControlPlaneApp(options.routes ?? catalog, host);
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
  const http = createNodeHttpServer({
    fetch: (request) => Promise.resolve(app.fetch(request, env)),
    upgrade,
    health,
    log,
  });
  const { server } = http;

  server.listen(settings.port, settings.host);
  acquire(() => {
    server.closeAllConnections();
    server.close();
  });
  await once(server, "listening");
  const address = server.address() as AddressInfo;

  clock.start();
  acquire(() => clock.stop());
  registry.startSweeper();
  acquire(() => registry.stopSweeper());
  cron.start();
  acquire(() => cron.stop());
  clocksRunning = true;
  log.info("node_host.listening", {
    event: "node_host.listening",
    host: address.address,
    port: address.port,
    data_dir: settings.dataDir,
    migrations_applied: migrationsApplied,
  });

  const shutdown = async (): Promise<ShutdownReport> => {
    draining = true;
    const deadlineMs = Date.now() + settings.shutdownTimeoutMs;
    const remaining = (): number => Math.max(0, deadlineMs - Date.now());
    log.info("node_host.draining", {
      event: "node_host.draining",
      timeout_ms: settings.shutdownTimeoutMs,
    });

    // Producers first: nothing new starts. `server.close()` stops new
    // connections; idle keep-alive connections go now, requests in flight
    // are drained below.
    cron.stop();
    clock.stop();
    clocksRunning = false;
    const closed = once(server, "close");
    server.close();
    server.closeIdleConnections();

    // Everything that can still reach a runtime, under the one budget.
    const abandoned: string[] = [];
    const requests = await http.drain(remaining());
    if (requests > 0) abandoned.push(`http_requests:${requests}`);
    const runs = await cron.drain(remaining());
    if (runs > 0) abandoned.push(`scheduled_runs:${runs}`);
    if (!(await settlesWithin([clock.drain()], remaining()))) abandoned.push("alarm_deliveries");
    const tasks = await processTasks.drain(remaining());
    if (tasks > 0) abandoned.push(`background_tasks:${tasks}`);

    // Then the runtimes: sockets closed with 1012, per-session work waited for.
    await registry.shutdown({ timeoutMs: remaining() });

    // Then the transports. A peer that ignored its close frame is cut, as
    // is any connection still open, so the server's close can complete.
    for (const client of webSocketServer.clients) client.terminate();
    await new Promise<void>((done) => webSocketServer.close(() => done()));
    server.closeAllConnections();
    await closed;

    alarmIndex.close();
    db.close();

    const report: ShutdownReport = { clean: abandoned.length === 0, abandoned };
    if (report.clean) {
      log.info("node_host.stopped", { event: "node_host.stopped" });
    } else {
      log.warn("node_host.stopped_unclean", { event: "node_host.stopped_unclean", abandoned });
    }
    return report;
  };

  let stopping: Promise<ShutdownReport> | null = null;
  return {
    address,
    health,
    shutdown: () => (stopping ??= shutdown()),
  };
}

/** How many migrations the global store's ledger records, for the health report. */
async function countMigrations(db: SqlDatabase): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS applied FROM _schema_migrations")
    .first<{ applied: number }>();
  return row?.applied ?? 0;
}
