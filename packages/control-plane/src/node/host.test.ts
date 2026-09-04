import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import { NO_AUTHORIZATION } from "../routes/shared";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { DEFAULT_MIGRATIONS_DIR, type NodeHostSettings } from "./config";
import { GLOBAL_STORE_FILE, startNodeHost, type NodeHost, type NodeHostOptions } from "./host";
import type { HealthReport } from "./http-server";

const KEY = Buffer.alloc(32, 7).toString("base64");

const CONFIG = {
  DEPLOYMENT_NAME: "test",
  GITHUB_BOT_USERNAME: "open-inspect[bot]",
  TOKEN_ENCRYPTION_KEY: KEY,
  PROVIDER_ACCOUNTS_ENCRYPTION_KEY: KEY,
  REPO_SECRETS_ENCRYPTION_KEY: KEY,
  LOG_LEVEL: "error",
};

const OBJECT_STORAGE = { bucket: "media", region: "us-east-1" };

/** A public route that answers once `release` is called, for shutdown against work in flight. */
function blockingRoute(): { routes: Hono<ControlPlaneHonoEnv>[]; release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const routes = new Hono<ControlPlaneHonoEnv>();
  routes.get(
    "/block",
    admit({
      authentication: { kind: "public" },
      supportedScmProviders: "all",
      authorization: NO_AUTHORIZATION,
    }),
    async () => {
      await held;
      return Response.json({ released: true });
    }
  );
  return { routes: [routes], release };
}

describe("startNodeHost", () => {
  let dataDir: string;
  let host: NodeHost | null = null;

  const settings = (overrides: Partial<NodeHostSettings> = {}): NodeHostSettings => ({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    migrationsDir: DEFAULT_MIGRATIONS_DIR,
    shutdownTimeoutMs: 5_000,
    ...overrides,
  });

  const start = (overrides: Partial<NodeHostOptions> = {}): Promise<NodeHost> => {
    dataDir ??= mkdtempSync(join(tmpdir(), "node-host-"));
    return startNodeHost({
      config: CONFIG,
      settings: settings(),
      objectStorage: OBJECT_STORAGE,
      ...overrides,
    });
  };

  afterEach(async () => {
    await host?.shutdown();
    host = null;
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined as unknown as string;
  });

  it("boots over the migrated global store and answers the health check and the route table", async () => {
    host = await start();
    const base = `http://127.0.0.1:${host.address.port}`;
    expect(existsSync(join(dataDir, GLOBAL_STORE_FILE))).toBe(true);

    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    const report = (await health.json()) as HealthReport;
    expect(report).toMatchObject({
      status: "ok",
      sessions_resident: 0,
      alarm_clock: "running",
      cron: "running",
    });
    expect(report.migrations_applied).toBeGreaterThan(0);

    const missing = await fetch(`${base}/no-such-route`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Not found" });
    expect(missing.headers.get("x-request-id")).toBeTruthy();

    // A catalog route answers through admission: unauthenticated, not unknown.
    const listed = await fetch(`${base}/sessions`);
    expect(listed.status).toBe(401);
  });

  it("refuses a WebSocket upgrade for an unknown session and any other upgrade path", async () => {
    host = await start();
    const base = `ws://127.0.0.1:${host.address.port}`;
    const rejection = (path: string): Promise<string> =>
      new Promise((resolve) => {
        new NodeWebSocket(`${base}${path}`).once("error", (error) => resolve(error.message));
      });
    expect(await rejection("/sessions/unknown/ws")).toBe("Unexpected server response: 404");
    expect(await rejection("/sessions/unknown/events")).toBe("Unexpected server response: 400");
  });

  it("reports draining once a shutdown begins and stops listening when it ends", async () => {
    host = await start();
    const base = `http://127.0.0.1:${host.address.port}`;

    const stopping = host.shutdown();
    expect(host.health().status).toBe("draining");
    expect(await stopping).toEqual({ clean: true, abandoned: [] });
    await expect(host.shutdown()).resolves.toEqual({ clean: true, abandoned: [] });
    await expect(fetch(`${base}/healthz`)).rejects.toThrow();
    host = null;
  });

  it("waits for a request in flight before closing the stores, and answers it", async () => {
    const { routes, release } = blockingRoute();
    host = await start({ routes });
    const base = `http://127.0.0.1:${host.address.port}`;

    const blocked = fetch(`${base}/block`);
    await vi.waitFor(async () => {
      // The request has reached the handler once a second one is admitted behind it.
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
    });
    const stopping = host.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Not closed underneath the handler: the shutdown is still waiting.
    let settled = false;
    void stopping.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    release();
    expect(await stopping).toEqual({ clean: true, abandoned: [] });
    const response = await blocked;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ released: true });
    host = null;
  });

  it("gives up a request that outlives the budget and reports it", async () => {
    const { routes } = blockingRoute();
    dataDir = mkdtempSync(join(tmpdir(), "node-host-"));
    host = await startNodeHost({
      config: CONFIG,
      settings: settings({ shutdownTimeoutMs: 200 }),
      objectStorage: OBJECT_STORAGE,
      routes,
    });
    const base = `http://127.0.0.1:${host.address.port}`;

    const blocked = fetch(`${base}/block`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const startedAt = Date.now();
    const report = await host.shutdown();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
    expect(report).toEqual({ clean: false, abandoned: ["http_requests:1"] });
    // The connection was cut at the end; the peer sees no answer.
    await expect(blocked).rejects.toThrow();
    host = null;
  });

  it("fails to boot on a malformed encryption key with the Worker's message, leaving nothing open", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "node-host-"));
    await expect(
      start({ config: { ...CONFIG, TOKEN_ENCRYPTION_KEY: "c2hvcnQ=" } })
    ).rejects.toThrow("TOKEN_ENCRYPTION_KEY must decode to 32 bytes for AES-256, got 5");
    expect(existsSync(join(dataDir, GLOBAL_STORE_FILE))).toBe(false);
    // A corrected boot over the same directory succeeds.
    host = await start();
    expect((await fetch(`http://127.0.0.1:${host.address.port}/healthz`)).status).toBe(200);
  });

  it("releases what it acquired when a later boot step fails", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "node-host-"));
    // Take the port first so listen fails after the stores were opened.
    const occupant = await start();
    await expect(
      startNodeHost({
        config: CONFIG,
        settings: settings({ port: occupant.address.port }),
        objectStorage: OBJECT_STORAGE,
      })
    ).rejects.toThrow(/EADDRINUSE/);
    await occupant.shutdown();
    // Both stores were closed by the rollback: a fresh boot opens them again.
    host = await start();
    expect((await fetch(`http://127.0.0.1:${host.address.port}/healthz`)).status).toBe(200);
  });
});
