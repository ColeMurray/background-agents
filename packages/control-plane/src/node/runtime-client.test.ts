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
  createSessionRuntimeClientForTraceOver,
  createSessionRuntimeClientOver,
} from "../session/runtime-client";
import { createNodeSessionRuntimeDispatch, type RequestServingRuntime } from "./runtime-client";
import { SessionRuntimeRegistry, type ManagedSessionRuntime } from "./session-runtime-registry";
import { createFileSessionStoreProvider } from "./session-store";

const ctx: CorrelationContext = { trace_id: "trace-1", request_id: "request-1" };

/** A lookup over one runtime shared by every present id, counting leases in flight. */
function fakeRuntimes(handle: (request: Request) => Promise<Response>) {
  const present = new Set<string>();
  const state = { inFlight: 0, released: 0 };
  const runtimes = {
    withRuntimeIfPresent: async <T>(
      sessionId: string,
      use: (runtime: RequestServingRuntime) => Promise<T>
    ): Promise<T | undefined> => {
      if (!present.has(sessionId)) return undefined;
      state.inFlight += 1;
      try {
        return await use({ server: { onRequest: handle } });
      } finally {
        state.inFlight -= 1;
        state.released += 1;
      }
    },
  };
  return { runtimes, present, state };
}

describe("createNodeSessionRuntimeDispatch", () => {
  it("delivers the client's correlated internal request to the session's runtime", async () => {
    const requests: Request[] = [];
    const { runtimes, present } = fakeRuntimes(async (request) => {
      requests.push(request);
      return Response.json({ ok: true });
    });
    present.add("session-1");
    const client = createSessionRuntimeClientOver(createNodeSessionRuntimeDispatch(runtimes), ctx);

    const response = await client.fetch(
      "session-1",
      SessionInternalPaths.events,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      "?limit=10"
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
    const request = requests[0]!;
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe(SessionInternalPaths.events);
    expect(new URL(request.url).search).toBe("?limit=10");
    expect(request.headers.get("x-trace-id")).toBe("trace-1");
    expect(request.headers.get("x-request-id")).toBe("request-1");
    expect(request.headers.get("Content-Type")).toBe("application/json");
    await expect(request.text()).resolves.toBe("{}");
  });

  it("answers 404 for a session the registry finds nothing behind", async () => {
    const handle = vi.fn(async () => new Response(null, { status: 200 }));
    const { runtimes } = fakeRuntimes(handle);
    const client = createSessionRuntimeClientOver(createNodeSessionRuntimeDispatch(runtimes), ctx);

    const response = await client.fetch("missing", SessionInternalPaths.expireDraft, {
      method: "POST",
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Session not found" });
    expect(handle).not.toHaveBeenCalled();
  });

  it("mints a fresh request id per call for a trace-only caller", async () => {
    const requests: Request[] = [];
    const { runtimes, present } = fakeRuntimes(async (request) => {
      requests.push(request);
      return new Response(null, { status: 200 });
    });
    present.add("parent-1");
    const client = createSessionRuntimeClientForTraceOver(
      createNodeSessionRuntimeDispatch(runtimes),
      "child-session-id"
    );

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

  describe("abort", () => {
    it("rejects an already-aborted request without touching the registry", async () => {
      const handle = vi.fn(async () => new Response(null, { status: 200 }));
      const { runtimes, present, state } = fakeRuntimes(handle);
      present.add("s1");
      const client = createSessionRuntimeClientOver(
        createNodeSessionRuntimeDispatch(runtimes),
        ctx
      );
      const controller = new AbortController();
      controller.abort(new Error("gone before dispatch"));

      await expect(
        client.fetch("s1", SessionInternalPaths.state, { signal: controller.signal })
      ).rejects.toThrow("gone before dispatch");
      expect(handle).not.toHaveBeenCalled();
      expect(state.inFlight).toBe(0);
    });

    it("rejects promptly when the signal aborts mid-handler and releases the lease when the handler settles", async () => {
      let finish!: () => void;
      const handlerDone = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const { runtimes, present, state } = fakeRuntimes(async () => {
        await handlerDone;
        return new Response(null, { status: 200 });
      });
      present.add("s1");
      const client = createSessionRuntimeClientOver(
        createNodeSessionRuntimeDispatch(runtimes),
        ctx
      );
      const controller = new AbortController();

      const pending = client.fetch("s1", SessionInternalPaths.expireDraft, {
        method: "POST",
        signal: controller.signal,
      });
      await new Promise((tick) => setImmediate(tick));
      expect(state.inFlight).toBe(1);

      controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
      await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
      // The handler is still running under its lease; only the caller has gone.
      expect(state.inFlight).toBe(1);
      expect(state.released).toBe(0);

      finish();
      await new Promise((tick) => setImmediate(tick));
      expect(state.inFlight).toBe(0);
      expect(state.released).toBe(1);
    });

    it("stops listening to a signal once the request has settled", async () => {
      const { runtimes, present } = fakeRuntimes(async () => new Response(null, { status: 200 }));
      present.add("s1");
      const client = createSessionRuntimeClientOver(
        createNodeSessionRuntimeDispatch(runtimes),
        ctx
      );
      const controller = new AbortController();

      const response = await client.fetch("s1", SessionInternalPaths.state, {
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      controller.abort();
      await expect(response.text()).resolves.toBe("");
    });
  });
});

describe("with the session runtime registry", () => {
  type Runtime = ManagedSessionRuntime & RequestServingRuntime;
  let dataDir: string;
  let now: number;
  let registry: SessionRuntimeRegistry<Runtime>;
  let builds: number;
  const indexed = new Set<string>();

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
    indexed.clear();
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
    log.child.mockReturnValue(log);
    registry = new SessionRuntimeRegistry<Runtime>({
      db: {} as SqlDatabase,
      storeProvider: createFileSessionStoreProvider(dataDir),
      sessionIndex: { exists: async (id) => indexed.has(id) },
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

  it("creates a session from its index row, and re-opens it from its store once evicted", async () => {
    const stores = createFileSessionStoreProvider(dataDir);
    const client = createSessionRuntimeClientOver(createNodeSessionRuntimeDispatch(registry), ctx);

    // Unknown everywhere: nothing is built and no store appears.
    const missing = await client.fetch("s1", SessionInternalPaths.state);
    expect(missing.status).toBe(404);
    expect(builds).toBe(0);
    expect(await stores.exists("s1")).toBe(false);

    // Creation: the index row exists before the store does.
    indexed.add("s1");
    const created = await client.fetch("s1", SessionInternalPaths.init, { method: "POST" });
    await expect(created.json()).resolves.toEqual({ path: SessionInternalPaths.init });
    expect(builds).toBe(1);
    expect(await stores.exists("s1")).toBe(true);

    now += 2_000;
    expect(await registry.sweep()).toEqual(["s1"]);
    expect(registry.residentSessionIds()).toEqual([]);

    // The index row is gone; the store alone brings the session back.
    indexed.delete("s1");
    const reopened = await client.fetch("s1", SessionInternalPaths.state);
    await expect(reopened.json()).resolves.toEqual({ path: SessionInternalPaths.state });
    expect(builds).toBe(2);
    expect(registry.residentSessionIds()).toEqual(["s1"]);
  });
});
