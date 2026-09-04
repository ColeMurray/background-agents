import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import type { SqlDatabase } from "../db/sql-database";
import type { AlarmScheduleStore } from "../session/alarm/scheduler";
import type { SessionRuntime } from "../session/components";
import type { SessionPlatform, SessionStorage } from "../session/platform";
import type { BackgroundTasks } from "../platform-ports";
import {
  SERVICE_RESTART_CLOSE_CODE,
  SessionRuntimeRegistry,
  type ManagedSessionRuntime,
  type SessionRuntimeRegistryOptions,
} from "./session-runtime-registry";
import { createFileSessionStoreProvider, type SessionStoreProvider } from "./session-store";

const GC_CHILD = "SESSION_REGISTRY_GC_CHILD";
const GC_CHILD_TIMEOUT_MS = 60_000;
const isGcChild = process.env[GC_CHILD] === "1";

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> => new Promise((done) => setImmediate(done));

function spyLogger() {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  log.child.mockReturnValue(log);
  return log;
}

/** A runtime double exposing what the registry handed it and what it received. */
interface FakeRuntime extends ManagedSessionRuntime {
  platform: SessionPlatform;
  rehydrated: number;
  tasks: BackgroundTasks | null;
  server: {
    onMessage: ReturnType<typeof vi.fn<(ws: unknown, message: unknown) => Promise<void>>>;
    onClose: ReturnType<
      typeof vi.fn<(ws: unknown, code: number, reason: string, wasClean: boolean) => Promise<void>>
    >;
    onError: ReturnType<typeof vi.fn<(ws: unknown, error: Error) => void>>;
    onScheduledDeadline: ReturnType<typeof vi.fn<() => Promise<void>>>;
  };
}

function fakeRuntime(platform: SessionPlatform, options: { tasks?: boolean } = {}): FakeRuntime {
  const runtime: FakeRuntime = {
    platform,
    rehydrated: 0,
    tasks: null,
    server: {
      onMessage: vi.fn(async () => {}),
      onClose: vi.fn(async () => {}),
      onError: vi.fn(),
      onScheduledDeadline: vi.fn(async () => {}),
    },
    alarms: {
      rehydrate: () => {
        runtime.rehydrated += 1;
      },
    },
  };
  if (options.tasks) runtime.tasks = platform.createBackgroundTasks(spyLogger() as never);
  return runtime;
}

/** Stores that open in memory (nothing is queried) and count their closes. */
function fakeStores() {
  const opened: Array<{ id: string; storage: SessionStorage; closes: number }> = [];
  const state = { gate: null as Deferred | null, failNext: null as Error | null };
  const provider: SessionStoreProvider = {
    exists: async (id) => opened.some((record) => record.id === id),
    open: async (id) => {
      if (state.gate) await state.gate.promise;
      if (state.failNext) {
        const error = state.failNext;
        state.failNext = null;
        throw error;
      }
      const record = { id, storage: {} as SessionStorage, closes: 0 };
      opened.push(record);
      return {
        storage: record.storage,
        close: () => {
          record.closes += 1;
        },
      };
    },
  };
  return { opened, state, provider };
}

function fakeAlarms() {
  const deadlines = new Map<string, number | null>();
  const reads = { gate: null as Deferred | null };
  const alarmStoreFor = (id: string): AlarmScheduleStore => ({
    getAlarm: async () => {
      if (reads.gate) await reads.gate.promise;
      return deadlines.get(id) ?? null;
    },
    setAlarm: async (at) => {
      deadlines.set(id, at);
    },
    deleteAlarm: async () => {
      deadlines.delete(id);
    },
  });
  return { deadlines, reads, alarmStoreFor };
}

const IDLE_AFTER_MS = 120_000;
const HORIZON_MS = 60_000;

describe("SessionRuntimeRegistry", () => {
  let now: number;
  const clock = { now: () => now, advance: (ms: number) => (now += ms) };
  let stores: ReturnType<typeof fakeStores>;
  let index: {
    known: Set<string>;
    exists: ReturnType<typeof vi.fn<(id: string) => Promise<boolean>>>;
  };
  let alarms: ReturnType<typeof fakeAlarms>;
  let log: ReturnType<typeof spyLogger>;
  let built: FakeRuntime[];
  let buildRuntime: ReturnType<typeof vi.fn<(platform: SessionPlatform) => FakeRuntime>>;
  let registries: SessionRuntimeRegistry<FakeRuntime>[];

  const makeRegistry = (
    overrides: Partial<SessionRuntimeRegistryOptions<FakeRuntime>> = {}
  ): SessionRuntimeRegistry<FakeRuntime> => {
    const registry = new SessionRuntimeRegistry<FakeRuntime>({
      db: {} as SqlDatabase,
      storeProvider: stores.provider,
      sessionIndex: index,
      alarmStoreFor: alarms.alarmStoreFor,
      buildRuntime,
      log: log as never,
      nowMs: clock.now,
      idleAfterMs: IDLE_AFTER_MS,
      deadlineHorizonMs: HORIZON_MS,
      ...overrides,
    });
    registries.push(registry);
    return registry;
  };

  beforeEach(() => {
    now = 1_000_000;
    stores = fakeStores();
    const known = new Set<string>();
    index = { known, exists: vi.fn(async (id: string) => known.has(id)) };
    alarms = fakeAlarms();
    log = spyLogger();
    built = [];
    buildRuntime = vi.fn((platform: SessionPlatform) => {
      const runtime = fakeRuntime(platform);
      built.push(runtime);
      return runtime;
    });
    registries = [];
  });

  afterEach(async () => {
    for (const registry of registries) await registry.shutdown({ timeoutMs: 1_000 });
  });

  it("is driven by what SessionRuntime exposes", () => {
    expectTypeOf<SessionRuntime>().toExtend<ManagedSessionRuntime>();
  });

  it("opens a session on first touch, rehydrates it once, and reuses it after", async () => {
    const registry = makeRegistry();

    const first = await registry.withRuntime("s1", async (runtime) => runtime);
    const second = await registry.withRuntime("s1", async (runtime) => runtime);

    expect(second).toBe(first);
    expect(buildRuntime).toHaveBeenCalledTimes(1);
    expect(first.platform.id).toBe("s1");
    expect(first.platform.storage).toBe(stores.opened[0]!.storage);
    expect(first.rehydrated).toBe(1);
    expect(stores.opened.map((s) => s.id)).toEqual(["s1"]);
    expect(registry.residentSessionIds()).toEqual(["s1"]);
  });

  it("shares one build between concurrent opens of a cold session", async () => {
    const registry = makeRegistry();
    stores.state.gate = deferred();

    const a = registry.withRuntime("s1", async (runtime) => runtime);
    const b = registry.withRuntime("s1", async (runtime) => runtime);
    await flush();
    expect(buildRuntime).not.toHaveBeenCalled();
    stores.state.gate.resolve();

    expect(await a).toBe(await b);
    expect(buildRuntime).toHaveBeenCalledTimes(1);
    expect(stores.opened).toHaveLength(1);
  });

  describe("withRuntimeIfPresent", () => {
    it("opens nothing for an id with neither a store nor an index row", async () => {
      const registry = makeRegistry();

      const outcome = await registry.withRuntimeIfPresent("ghost", async () => "used");

      expect(outcome).toBeUndefined();
      expect(buildRuntime).not.toHaveBeenCalled();
      expect(stores.opened).toEqual([]);
      expect(registry.residentSessionIds()).toEqual([]);
    });

    it("opens a session known to the index but without a store yet: the one being created", async () => {
      const registry = makeRegistry();
      index.known.add("s1");

      const outcome = await registry.withRuntimeIfPresent("s1", async (runtime) => runtime);

      expect(outcome).toBeDefined();
      expect(stores.opened.map((s) => s.id)).toEqual(["s1"]);
      expect(registry.residentSessionIds()).toEqual(["s1"]);
    });

    it("opens a session whose store exists after its index row is gone, without asking the index", async () => {
      const registry = makeRegistry();
      await registry.withRuntime("s1", async () => {});
      clock.advance(IDLE_AFTER_MS);
      expect(await registry.sweep()).toEqual(["s1"]);
      index.exists.mockClear();

      const outcome = await registry.withRuntimeIfPresent("s1", async (runtime) => runtime);

      expect(outcome).toBeDefined();
      expect(index.exists).not.toHaveBeenCalled();
      expect(buildRuntime).toHaveBeenCalledTimes(2);
    });

    it("shares one presence check and one build between concurrent conditional opens", async () => {
      const registry = makeRegistry();
      index.known.add("s1");
      stores.state.gate = deferred();

      const a = registry.withRuntimeIfPresent("s1", async (runtime) => runtime);
      const b = registry.withRuntimeIfPresent("s1", async (runtime) => runtime);
      await flush();
      stores.state.gate.resolve();

      expect(await a).toBe(await b);
      expect(index.exists).toHaveBeenCalledTimes(1);
      expect(buildRuntime).toHaveBeenCalledTimes(1);
    });

    it("lets an unconditional open that joined an absent outcome build on its own turn", async () => {
      const registry = makeRegistry();
      const lookup = deferred<boolean>();
      index.exists.mockImplementationOnce(() => lookup.promise);

      const conditional = registry.withRuntimeIfPresent("s1", async (runtime) => runtime);
      await flush();
      const unconditional = registry.withRuntime("s1", async (runtime) => runtime);
      lookup.resolve(false);

      expect(await conditional).toBeUndefined();
      expect(await unconditional).toBeDefined();
      expect(buildRuntime).toHaveBeenCalledTimes(1);
      expect(registry.residentSessionIds()).toEqual(["s1"]);
    });
  });

  it("does not cache a failed build: the store is closed and the next event retries", async () => {
    const registry = makeRegistry();
    buildRuntime.mockImplementationOnce(() => {
      throw new Error("provider misconfigured");
    });

    await expect(registry.withRuntime("s1", async () => {})).rejects.toThrow(
      "provider misconfigured"
    );
    expect(stores.opened).toMatchObject([{ id: "s1", closes: 1 }]);
    expect(registry.residentSessionIds()).toEqual([]);

    await registry.withRuntime("s1", async () => {});
    expect(buildRuntime).toHaveBeenCalledTimes(2);
    expect(registry.residentSessionIds()).toEqual(["s1"]);
  });

  it("retires a published runtime whose rehydration throws, so the next event retries", async () => {
    const registry = makeRegistry();
    buildRuntime.mockImplementationOnce((platform) => {
      const runtime = fakeRuntime(platform);
      runtime.alarms.rehydrate = () => {
        throw new Error("alarm index unavailable");
      };
      built.push(runtime);
      return runtime;
    });

    await expect(registry.withRuntime("s1", async () => {})).rejects.toThrow(
      "alarm index unavailable"
    );
    expect(registry.residentSessionIds()).toEqual([]);
    expect(stores.opened).toMatchObject([{ id: "s1", closes: 1 }]);

    await registry.withRuntime("s1", async () => {});
    expect(buildRuntime).toHaveBeenCalledTimes(2);
    expect(registry.residentSessionIds()).toEqual(["s1"]);
  });

  it("leaves nothing resident when the store fails to open", async () => {
    const registry = makeRegistry();
    stores.state.failNext = new Error("disk full");

    await expect(registry.withRuntime("s1", async () => {})).rejects.toThrow("disk full");
    expect(buildRuntime).not.toHaveBeenCalled();
    expect(registry.residentSessionIds()).toEqual([]);

    await registry.withRuntime("s1", async () => {});
    expect(registry.residentSessionIds()).toEqual(["s1"]);
  });

  it("opens for an alarm delivery without rehydrating, as the Durable Object does", async () => {
    const registry = makeRegistry();

    await registry.deliverScheduledDeadline("s1");

    expect(built[0]!.server.onScheduledDeadline).toHaveBeenCalledTimes(1);
    expect(built[0]!.rehydrated).toBe(0);
    // Already initialized: a later event does not rehydrate either.
    await registry.withRuntime("s1", async () => {});
    expect(built[0]!.rehydrated).toBe(0);
  });

  it("retires a runtime idle past idleAfterMs and closes its store exactly once", async () => {
    const registry = makeRegistry();
    await registry.withRuntime("s1", async () => {});

    clock.advance(IDLE_AFTER_MS - 1);
    expect(await registry.sweep()).toEqual([]);
    clock.advance(1);
    expect(await registry.sweep()).toEqual(["s1"]);

    expect(stores.opened).toMatchObject([{ id: "s1", closes: 1 }]);
    expect(registry.residentSessionIds()).toEqual([]);
    await registry.shutdown();
    expect(stores.opened[0]!.closes).toBe(1);
  });

  it("reopens a retired session from its file with its state intact", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "session-registry-"));
    try {
      const registry = makeRegistry({ storeProvider: createFileSessionStoreProvider(dataDir) });
      const rows = (runtime: FakeRuntime): number =>
        (
          runtime.platform.storage.sql.exec("SELECT count(*) AS n FROM marker").one() as {
            n: number;
          }
        ).n;

      await registry.withRuntime("s1", async (runtime) => {
        runtime.platform.storage.sql.exec("CREATE TABLE marker (v TEXT)");
        runtime.platform.storage.sql.exec("INSERT INTO marker VALUES ('x')");
      });
      clock.advance(IDLE_AFTER_MS);
      expect(await registry.sweep()).toEqual(["s1"]);

      expect(await registry.withRuntime("s1", async (runtime) => rows(runtime))).toBe(1);
      expect(buildRuntime).toHaveBeenCalledTimes(2);
      await registry.shutdown();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps a runtime with an event in flight", async () => {
    const registry = makeRegistry();
    const inFlight = deferred();
    const pending = registry.withRuntime("s1", () => inFlight.promise);
    await flush();

    clock.advance(IDLE_AFTER_MS);
    expect(await registry.sweep()).toEqual([]);

    inFlight.resolve();
    await pending;
    // Finishing the event is activity too.
    expect(await registry.sweep()).toEqual([]);
    clock.advance(IDLE_AFTER_MS);
    expect(await registry.sweep()).toEqual(["s1"]);
  });

  it("keeps a runtime with a background task running", async () => {
    const registry = makeRegistry();
    buildRuntime.mockImplementationOnce((platform) => {
      const runtime = fakeRuntime(platform, { tasks: true });
      built.push(runtime);
      return runtime;
    });
    const work = deferred();
    await registry.withRuntime("s1", async (runtime) => {
      runtime.tasks!.submit(() => work.promise, { name: "test.task" });
    });

    clock.advance(IDLE_AFTER_MS);
    expect(await registry.sweep()).toEqual([]);

    work.resolve();
    await flush();
    expect(await registry.sweep()).toEqual(["s1"]);
  });

  it("keeps a runtime whose next deadline is within the horizon", async () => {
    const registry = makeRegistry();
    await registry.withRuntime("s1", async () => {});
    clock.advance(IDLE_AFTER_MS);

    alarms.deadlines.set("s1", clock.now() + HORIZON_MS);
    expect(await registry.sweep()).toEqual([]);
    alarms.deadlines.set("s1", clock.now() + HORIZON_MS + 1);
    expect(await registry.sweep()).toEqual(["s1"]);
  });

  it("skips a runtime whose deadline cannot be read", async () => {
    const registry = makeRegistry({
      alarmStoreFor: () => ({
        getAlarm: async () => {
          throw new Error("index closed");
        },
        setAlarm: async () => {},
        deleteAlarm: async () => {},
      }),
    });
    await registry.withRuntime("s1", async () => {});
    clock.advance(IDLE_AFTER_MS);

    expect(await registry.sweep()).toEqual([]);
    expect(log.error).toHaveBeenCalledWith(
      "session_registry.deadline_unreadable",
      expect.objectContaining({ session_id: "s1" })
    );
  });

  it("does not retire a runtime an event reached while the sweep read its deadline", async () => {
    const registry = makeRegistry();
    await registry.withRuntime("s1", async () => {});
    clock.advance(IDLE_AFTER_MS);
    alarms.reads.gate = deferred();

    const sweep = registry.sweep();
    await flush();
    const inFlight = deferred();
    const pending = registry.withRuntime("s1", () => inFlight.promise);
    await flush();
    alarms.reads.gate.resolve();

    expect(await sweep).toEqual([]);
    expect(stores.opened[0]!.closes).toBe(0);
    inFlight.resolve();
    await pending;
  });

  it("retires the least recently active quiescent runtime to stay under maxResident", async () => {
    const registry = makeRegistry({ maxResident: 2 });
    await registry.withRuntime("s1", async () => {});
    clock.advance(1);
    await registry.withRuntime("s2", async () => {});
    clock.advance(1);
    // s1 is touched again, so s2 is now the least recently active.
    await registry.withRuntime("s1", async () => {});
    clock.advance(1);

    await registry.withRuntime("s3", async () => {});

    expect(registry.residentSessionIds()).toEqual(["s1", "s3"]);
    expect(stores.opened.find((s) => s.id === "s2")!.closes).toBe(1);
  });

  it("exceeds maxResident rather than retiring a runtime with work in flight", async () => {
    const registry = makeRegistry({ maxResident: 1 });
    const inFlight = deferred();
    const pending = registry.withRuntime("s1", () => inFlight.promise);
    await flush();

    await registry.withRuntime("s2", async () => {});

    expect(registry.residentSessionIds()).toEqual(["s1", "s2"]);
    expect(log.warn).toHaveBeenCalledWith("session_registry.resident_cap_exceeded", {
      max_resident: 1,
      resident: 2,
    });
    inFlight.resolve();
    await pending;
  });

  describe("with sockets", () => {
    let wss: WebSocketServer;
    const clients: NodeWebSocket[] = [];

    beforeEach(async () => {
      wss = new WebSocketServer({ port: 0 });
      await new Promise<void>((done) => wss.once("listening", done));
    });

    afterEach(async () => {
      for (const client of clients.splice(0)) client.terminate();
      await new Promise<void>((done) => wss.close(() => done()));
    });

    const connect = async (): Promise<{ server: NodeWebSocket; client: NodeWebSocket }> => {
      const { port } = wss.address() as AddressInfo;
      const serverSide = new Promise<NodeWebSocket>((done) => wss.once("connection", done));
      const client = new NodeWebSocket(`ws://127.0.0.1:${port}`);
      clients.push(client);
      await new Promise<void>((done) => client.once("open", done));
      return { server: await serverSide, client };
    };

    it("routes socket events through the runtime, and keeps it resident until the socket closes", async () => {
      const registry = makeRegistry();
      const { server, client } = await connect();
      const runtime = await registry.withRuntime("s1", async (runtime) => {
        runtime.platform.sockets.adopt(server, ["wsid:c1"]);
        return runtime;
      });

      client.send("hello");
      await vi.waitFor(() =>
        expect(runtime.server.onMessage).toHaveBeenCalledWith(server, "hello")
      );
      expect(runtime.platform.sockets.tags(server)).toEqual(["wsid:c1"]);

      clock.advance(IDLE_AFTER_MS);
      expect(await registry.sweep()).toEqual([]);

      client.close(1000, "done");
      await vi.waitFor(() =>
        expect(runtime.server.onClose).toHaveBeenCalledWith(server, 1000, "done", true)
      );
      // The close was delivered at the current time, so the runtime is not idle yet.
      expect(await registry.sweep()).toEqual([]);
      clock.advance(IDLE_AFTER_MS);
      expect(await registry.sweep()).toEqual(["s1"]);
    });

    it("shutdown closes adopted sockets with 1012 and delivers their close against an open store", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "session-registry-shutdown-"));
      try {
        const registry = makeRegistry({ storeProvider: createFileSessionStoreProvider(dataDir) });
        const { server, client } = await connect();
        const closed = new Promise<{ code: number; reason: string }>((done) =>
          client.once("close", (code, reason) => done({ code, reason: reason.toString() }))
        );
        const runtime = await registry.withRuntime("s1", async (runtime) => {
          runtime.platform.sockets.adopt(server, ["wsid:c1"]);
          return runtime;
        });
        // The production disconnect path persists cleanup; a closed store
        // would throw here and the host would log a failed delivery.
        let deliveredAgainstOpenStore = false;
        runtime.server.onClose.mockImplementation(async () => {
          runtime.platform.storage.sql.exec("SELECT count(*) AS n FROM session").one();
          deliveredAgainstOpenStore = true;
        });
        await registry.withRuntime("s2", async () => {});

        await registry.shutdown();

        expect(await closed).toEqual({
          code: SERVICE_RESTART_CLOSE_CODE,
          reason: "Service restart",
        });
        expect(runtime.server.onClose).toHaveBeenCalledWith(server, 1012, "Service restart", true);
        expect(deliveredAgainstOpenStore).toBe(true);
        expect(registry.residentSessionIds()).toEqual([]);
        for (const id of ["s1", "s2"]) {
          expect(log.info).toHaveBeenCalledWith(
            "session_registry.retired",
            expect.objectContaining({ session_id: id, reason: "shutdown" })
          );
        }
        expect(log.warn).not.toHaveBeenCalled();
        expect(log.error).not.toHaveBeenCalled();
        await expect(registry.withRuntime("s3", async () => {})).rejects.toThrow(
          "SessionRuntimeRegistry is shutting down"
        );
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    });
  });

  it("shutdown refuses new leases on resident runtimes and waits for held ones", async () => {
    const registry = makeRegistry();
    const held = deferred();
    const pending = registry.withRuntime("s1", () => held.promise);
    await flush();

    const shutdown = registry.shutdown();
    await flush();
    await expect(registry.withRuntime("s1", async () => {})).rejects.toThrow(
      "SessionRuntimeRegistry is shutting down"
    );
    expect(stores.opened[0]!.closes).toBe(0);

    held.resolve();
    await pending;
    await shutdown;
    expect(stores.opened[0]!.closes).toBe(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("shutdown forces a runtime still busy at the budget", async () => {
    const registry = makeRegistry();
    const never = deferred();
    const pending = registry.withRuntime("s1", () => never.promise);
    await flush();

    await registry.shutdown({ timeoutMs: 20 });

    expect(stores.opened[0]!.closes).toBe(1);
    expect(log.warn).toHaveBeenCalledWith("session_registry.retired_busy", {
      session_id: "s1",
      active_leases: 1,
      open_sockets: 0,
      background_tasks: 0,
    });
    never.resolve();
    await pending;
  });

  it("shutdown waits for a runtime's background tasks", async () => {
    const registry = makeRegistry();
    buildRuntime.mockImplementationOnce((platform) => {
      const runtime = fakeRuntime(platform, { tasks: true });
      built.push(runtime);
      return runtime;
    });
    const work = deferred();
    await registry.withRuntime("s1", async (runtime) => {
      runtime.tasks!.submit(() => work.promise, { name: "test.task" });
    });

    const shutdown = registry.shutdown();
    await flush();
    expect(stores.opened[0]!.closes).toBe(0);
    work.resolve();
    await shutdown;
    expect(stores.opened[0]!.closes).toBe(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("shutdown waits for an open in progress and retires what it built", async () => {
    const registry = makeRegistry();
    stores.state.gate = deferred();
    const pending = registry.withRuntime("s1", async () => "ran");
    await flush();

    const shutdown = registry.shutdown();
    stores.state.gate.resolve();
    await shutdown;

    // The build published and was retired; the event that started it is
    // refused its lease rather than handed a retired runtime.
    expect(stores.opened).toMatchObject([{ id: "s1", closes: 1 }]);
    expect(registry.residentSessionIds()).toEqual([]);
    await expect(pending).rejects.toThrow("SessionRuntimeRegistry is shutting down");
  });

  it("takes the lease in the continuation that saw the runtime resident", async () => {
    const registry = makeRegistry();
    await registry.withRuntime("s1", async () => {});
    clock.advance(IDLE_AFTER_MS);
    alarms.reads.gate = deferred();
    const sweep = registry.sweep();
    await flush();

    // No turn of the event loop between this call and the gate: the sweep's
    // re-check runs in the microtasks right after the lease is taken.
    const inFlight = deferred();
    const pending = registry.withRuntime("s1", () => inFlight.promise);
    alarms.reads.gate.resolve();

    expect(await sweep).toEqual([]);
    expect(stores.opened[0]!.closes).toBe(0);
    inFlight.resolve();
    await pending;
  });

  it("does not rehydrate an activation an alarm delivery joined", async () => {
    const registry = makeRegistry();
    stores.state.gate = deferred();
    const request = registry.withRuntime("s1", async () => {});
    const delivery = registry.deliverScheduledDeadline("s1");
    await flush();
    stores.state.gate.resolve();
    await Promise.all([request, delivery]);

    expect(buildRuntime).toHaveBeenCalledTimes(1);
    expect(built[0]!.rehydrated).toBe(0);
    expect(built[0]!.server.onScheduledDeadline).toHaveBeenCalledTimes(1);
  });

  it("does not rehydrate an activation a request joined after an alarm delivery started it", async () => {
    const registry = makeRegistry();
    stores.state.gate = deferred();
    const delivery = registry.deliverScheduledDeadline("s1");
    const request = registry.withRuntime("s1", async () => {});
    await flush();
    stores.state.gate.resolve();
    await Promise.all([delivery, request]);

    expect(buildRuntime).toHaveBeenCalledTimes(1);
    expect(built[0]!.rehydrated).toBe(0);
    expect(built[0]!.server.onScheduledDeadline).toHaveBeenCalledTimes(1);
  });

  it("admits concurrent cold opens at publish, exceeding the cap only for busy runtimes", async () => {
    const registry = makeRegistry({ maxResident: 1 });
    stores.state.gate = deferred();
    const first = deferred();
    const second = deferred();
    const a = registry.withRuntime("s1", () => first.promise);
    const b = registry.withRuntime("s2", () => second.promise);
    await flush();
    stores.state.gate.resolve();
    await flush();

    expect(registry.residentSessionIds().sort()).toEqual(["s1", "s2"]);
    expect(log.warn).toHaveBeenCalledWith("session_registry.resident_cap_exceeded", {
      max_resident: 1,
      resident: 2,
    });
    first.resolve();
    second.resolve();
    await Promise.all([a, b]);

    // Once both are quiescent, the next open brings residency back under the cap.
    await registry.withRuntime("s3", async () => {});
    expect(registry.residentSessionIds()).toEqual(["s3"]);
    expect(stores.opened.map((s) => `${s.id}:${s.closes}`)).toEqual(["s1:1", "s2:1", "s3:0"]);
  });

  it("does not retire a resident to make room for a build that fails", async () => {
    const registry = makeRegistry({ maxResident: 1 });
    await registry.withRuntime("s1", async () => {});
    buildRuntime.mockImplementationOnce(() => {
      throw new Error("provider misconfigured");
    });

    await expect(registry.withRuntime("s2", async () => {})).rejects.toThrow(
      "provider misconfigured"
    );

    expect(registry.residentSessionIds()).toEqual(["s1"]);
    expect(stores.opened.map((s) => s.closes)).toEqual([0, 1]);
  });

  it("survives late garbage collection of a retired session's store", () => {
    if (isGcChild) return;
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const vitestRoot = dirname(dirname(fileURLToPath(import.meta.resolve("vitest"))));
    const child = spawnSync(
      process.execPath,
      ["--expose-gc", "--no-warnings", join(vitestRoot, "vitest.mjs"), "run", import.meta.filename],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: { ...process.env, [GC_CHILD]: "1" },
        timeout: GC_CHILD_TIMEOUT_MS,
      }
    );

    expect(
      { status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr },
      "the isolated registry eviction probe must exit normally"
    ).toMatchObject({ status: 0, signal: null });
  });
});

if (isGcChild) {
  describe("session registry eviction under late garbage collection", () => {
    it("opens, reads, retires, and lets the collector run afterwards", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "session-registry-gc-"));
      const alarms = fakeAlarms();
      const registry = new SessionRuntimeRegistry<FakeRuntime>({
        db: {} as SqlDatabase,
        storeProvider: createFileSessionStoreProvider(dataDir),
        sessionIndex: { exists: async () => false },
        alarmStoreFor: alarms.alarmStoreFor,
        buildRuntime: (platform) => fakeRuntime(platform),
        log: spyLogger() as never,
        idleAfterMs: 0,
      });
      try {
        for (let round = 0; round < 20; round += 1) {
          await registry.withRuntime(`s${round % 5}`, async (runtime) => {
            const { sql } = runtime.platform.storage;
            sql.exec("SELECT count(*) AS n FROM session").one();
            sql.exec("SELECT 1;\n");
          });
          await registry.sweep();
        }
        for (let attempt = 0; attempt < 3; attempt += 1) {
          (globalThis as { gc?: () => void }).gc?.();
          await new Promise<void>((done) => setImmediate(done));
        }
      } finally {
        await registry.shutdown();
        rmSync(dataDir, { recursive: true, force: true });
      }
    });
  });
}
