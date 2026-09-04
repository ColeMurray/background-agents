import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlDatabase } from "../db/sql-database";
import type { CorrelationContext } from "../logger";
import type { AlarmScheduleStore } from "../session/alarm/scheduler";
import { SessionInternalPaths } from "../session/contracts";
import type { SessionPlatform } from "../session/platform";
import {
  createNodeSessionRuntimeClient,
  createNodeSessionRuntimeClientForTrace,
  type NodeSessionRuntimeClientOptions,
  type RequestServingRuntime,
} from "./runtime-client";
import { SessionRuntimeRegistry, type ManagedSessionRuntime } from "./session-runtime-registry";
import { createFileSessionStoreProvider } from "./session-store";

const ctx: CorrelationContext = { trace_id: "trace-1", request_id: "request-1" };

/** A lookup over one runtime per id, counting how often each is used. */
function fakeRuntimes(handle: (request: Request) => Promise<Response>) {
  const uses = new Map<string, number>();
  const options: NodeSessionRuntimeClientOptions<RequestServingRuntime> = {
    runtimes: {
      withRuntime: async (sessionId, use) => {
        uses.set(sessionId, (uses.get(sessionId) ?? 0) + 1);
        return use({ server: { onRequest: handle } });
      },
    },
    sessionIndex: { exists: vi.fn(async () => false) },
    storeProvider: { exists: vi.fn(async () => false) },
  };
  return { options, uses };
}

describe("createNodeSessionRuntimeClient", () => {
  it("dispatches a correlated internal request to the session's runtime", async () => {
    const requests: Request[] = [];
    const { options, uses } = fakeRuntimes(async (request) => {
      requests.push(request);
      return Response.json({ ok: true });
    });
    vi.mocked(options.storeProvider.exists).mockResolvedValue(true);

    const response = await createNodeSessionRuntimeClient(options, ctx).fetch(
      "session-1",
      SessionInternalPaths.events,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      "?limit=10"
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(uses.get("session-1")).toBe(1);
    const request = requests[0]!;
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe(SessionInternalPaths.events);
    expect(new URL(request.url).search).toBe("?limit=10");
    expect(request.headers.get("x-trace-id")).toBe("trace-1");
    expect(request.headers.get("x-request-id")).toBe("request-1");
    expect(request.headers.get("Content-Type")).toBe("application/json");
    await expect(request.text()).resolves.toBe("{}");
  });

  it("answers 404 for a session with no store and no index row without opening a runtime", async () => {
    const handle = vi.fn(async () => new Response(null, { status: 200 }));
    const { options, uses } = fakeRuntimes(handle);

    const response = await createNodeSessionRuntimeClient(options, ctx).fetch(
      "missing",
      SessionInternalPaths.expireDraft,
      { method: "POST" }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Session not found" });
    expect(uses.size).toBe(0);
    expect(handle).not.toHaveBeenCalled();
  });

  it("opens a runtime for a session that has an index row but no store yet", async () => {
    const { options, uses } = fakeRuntimes(async () => new Response(null, { status: 201 }));
    vi.mocked(options.sessionIndex.exists).mockResolvedValue(true);

    const response = await createNodeSessionRuntimeClient(options, ctx).fetch(
      "session-new",
      SessionInternalPaths.init,
      { method: "POST" }
    );

    expect(response.status).toBe(201);
    expect(uses.get("session-new")).toBe(1);
  });

  it("answers 404 rather than throwing for an id that cannot name a store", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "runtime-client-"));
    try {
      const { options } = fakeRuntimes(async () => new Response(null, { status: 200 }));
      options.storeProvider = createFileSessionStoreProvider(dataDir);

      const response = await createNodeSessionRuntimeClient(options, ctx).fetch(
        "../outside",
        SessionInternalPaths.state
      );

      expect(response.status).toBe(404);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("createNodeSessionRuntimeClientForTrace", () => {
  it("keeps the trace and mints a fresh request id for every call", async () => {
    const requests: Request[] = [];
    const { options } = fakeRuntimes(async (request) => {
      requests.push(request);
      return new Response(null, { status: 200 });
    });
    vi.mocked(options.storeProvider.exists).mockResolvedValue(true);

    const client = createNodeSessionRuntimeClientForTrace(options, "child-session-id");
    await client.fetch("parent-1", SessionInternalPaths.childSessionUpdate, { method: "POST" });
    await client.fetch("parent-1", SessionInternalPaths.childSessionUpdate, { method: "POST" });

    expect(requests.map((request) => request.headers.get("x-trace-id"))).toEqual([
      "child-session-id",
      "child-session-id",
    ]);
    const requestIds = requests.map((request) => request.headers.get("x-request-id"));
    expect(requestIds[0]).toMatch(/[0-9a-f-]{36}/);
    expect(requestIds[0]).not.toBe(requestIds[1]);
  });
});

describe("with the session runtime registry", () => {
  type Runtime = ManagedSessionRuntime & RequestServingRuntime;
  let dataDir: string;
  let now: number;
  let registry: SessionRuntimeRegistry<Runtime>;
  let builds: number;

  const alarmStoreFor = (): AlarmScheduleStore => ({
    getAlarm: async () => null,
    setAlarm: async () => {},
    deleteAlarm: async () => {},
  });

  const buildRuntime = (): Runtime => {
    builds += 1;
    return {
      server: {
        onRequest: async (request) => Response.json({ path: new URL(request.url).pathname }),
        onMessage: async () => {},
        onClose: async () => {},
        onError: () => {},
        onScheduledDeadline: async () => {},
      },
      alarms: { rehydrate: () => {} },
    };
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "runtime-client-registry-"));
    now = 1_000_000;
    builds = 0;
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
    log.child.mockReturnValue(log);
    registry = new SessionRuntimeRegistry<Runtime>({
      db: {} as SqlDatabase,
      storeProvider: createFileSessionStoreProvider(dataDir),
      alarmStoreFor,
      buildRuntime: buildRuntime as (platform: SessionPlatform) => Runtime,
      log: log as never,
      nowMs: () => now,
      idleAfterMs: 1_000,
    });
  });

  afterEach(async () => {
    await registry.shutdown({ timeoutMs: 1_000 });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("re-opens a session the registry evicted, from its store on disk", async () => {
    const storeProvider = createFileSessionStoreProvider(dataDir);
    // Creation: the index row exists before the store does.
    const index = { exists: async () => true };
    const client = createNodeSessionRuntimeClient(
      { runtimes: registry, sessionIndex: index, storeProvider },
      ctx
    );

    const created = await client.fetch("s1", SessionInternalPaths.init, { method: "POST" });
    await expect(created.json()).resolves.toEqual({ path: SessionInternalPaths.init });
    expect(builds).toBe(1);
    expect(await storeProvider.exists("s1")).toBe(true);

    now += 2_000;
    expect(await registry.sweep()).toEqual(["s1"]);
    expect(registry.residentSessionIds()).toEqual([]);

    // The index row is gone; the store alone brings the session back.
    const evicted = createNodeSessionRuntimeClient(
      { runtimes: registry, sessionIndex: { exists: async () => false }, storeProvider },
      ctx
    );
    const reopened = await evicted.fetch("s1", SessionInternalPaths.state);
    await expect(reopened.json()).resolves.toEqual({ path: SessionInternalPaths.state });
    expect(builds).toBe(2);
    expect(registry.residentSessionIds()).toEqual(["s1"]);
  });
});
