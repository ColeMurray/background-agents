import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import { DEFAULT_MIGRATIONS_DIR, type NodeHostSettings } from "./config";
import { GLOBAL_STORE_FILE, startNodeHost, type NodeHost } from "./host";
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

describe("startNodeHost", () => {
  let dataDir: string;
  let host: NodeHost | null = null;

  const settings = (): NodeHostSettings => ({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    migrationsDir: DEFAULT_MIGRATIONS_DIR,
    shutdownTimeoutMs: 5_000,
  });

  afterEach(async () => {
    await host?.shutdown();
    host = null;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("boots over the migrated global store and answers the health check and the route table", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "node-host-"));
    host = await startNodeHost({
      config: CONFIG,
      settings: settings(),
      objectStorage: OBJECT_STORAGE,
    });
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
    dataDir = mkdtempSync(join(tmpdir(), "node-host-"));
    host = await startNodeHost({
      config: CONFIG,
      settings: settings(),
      objectStorage: OBJECT_STORAGE,
    });
    const base = `ws://127.0.0.1:${host.address.port}`;
    const rejection = (path: string): Promise<string> =>
      new Promise((resolve) => {
        new NodeWebSocket(`${base}${path}`).once("error", (error) => resolve(error.message));
      });
    expect(await rejection("/sessions/unknown/ws")).toBe("Unexpected server response: 404");
    expect(await rejection("/sessions/unknown/events")).toBe("Unexpected server response: 400");
  });

  it("reports draining once a shutdown begins and stops listening when it ends", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "node-host-"));
    host = await startNodeHost({
      config: CONFIG,
      settings: settings(),
      objectStorage: OBJECT_STORAGE,
    });
    const base = `http://127.0.0.1:${host.address.port}`;

    const stopping = host.shutdown();
    expect(host.health().status).toBe("draining");
    await stopping;
    await expect(host.shutdown()).resolves.toBeUndefined();
    await expect(fetch(`${base}/healthz`)).rejects.toThrow();
    host = null;
  });

  it("fails to boot on a malformed encryption key with the Worker's message", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "node-host-"));
    await expect(
      startNodeHost({
        config: { ...CONFIG, TOKEN_ENCRYPTION_KEY: "c2hvcnQ=" },
        settings: settings(),
        objectStorage: OBJECT_STORAGE,
      })
    ).rejects.toThrow("TOKEN_ENCRYPTION_KEY must decode to 32 bytes for AES-256, got 5");
  });
});
