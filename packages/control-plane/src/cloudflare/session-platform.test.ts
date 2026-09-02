import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SqlDatabase } from "../db/sql-database";
import type { Logger } from "../logger";
import { createDurableObjectSessionPlatform } from "./session-platform";

/** Stand-in for the Workers runtime's request/response pair. */
class FakeRequestResponsePair {
  constructor(
    readonly request: string,
    readonly response: string
  ) {}
}

function createFakeState() {
  const storage = {
    sql: { exec: vi.fn() },
    transactionSync: vi.fn(<T>(closure: () => T): T => closure()),
    getAlarm: vi.fn(async () => null),
    setAlarm: vi.fn(async () => {}),
    deleteAlarm: vi.fn(async () => {}),
  };
  const calls = {
    id: { toString: () => "do-id" },
    storage,
    acceptWebSocket: vi.fn(),
    getTags: vi.fn(() => ["sandbox", "sid:sb-1"]),
    getWebSockets: vi.fn(() => []),
    setWebSocketAutoResponse: vi.fn(),
    waitUntil: vi.fn(),
  };
  const db = {} as SqlDatabase;
  return { state: calls as unknown as DurableObjectState, storage, calls, db };
}

describe("createDurableObjectSessionPlatform", () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocketRequestResponsePair", FakeRequestResponsePair);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exposes the object's id, storage, alarm store, and the global store", () => {
    const { state, storage, db } = createFakeState();

    const platform = createDurableObjectSessionPlatform(state, db);

    expect(platform.id).toBe("do-id");
    expect(platform.storage).toBe(storage);
    expect(platform.db).toBe(db);
    expect(platform.alarmStore).toBe(storage);
    expect(platform.storage.transactionSync(() => 42)).toBe(42);
    expect(storage.transactionSync).toHaveBeenCalledTimes(1);
  });

  it("delegates socket acceptance, tags, and enumeration, passing the tag filter through", () => {
    const { state, calls, db } = createFakeState();
    const ws = {} as WebSocket;

    const { sockets: host } = createDurableObjectSessionPlatform(state, db);
    host.accept(ws, ["sandbox", "sid:sb-1"]);
    host.sockets();
    host.sockets("sandbox");

    expect(calls.acceptWebSocket).toHaveBeenCalledWith(ws, ["sandbox", "sid:sb-1"]);
    expect(host.tags(ws)).toEqual(["sandbox", "sid:sb-1"]);
    expect(calls.getTags).toHaveBeenCalledWith(ws);
    expect(calls.getWebSockets.mock.calls).toEqual([[undefined], ["sandbox"]]);
  });

  it("installs the auto-response as a request/response pair", () => {
    const { state, calls, db } = createFakeState();

    const platform = createDurableObjectSessionPlatform(state, db);
    platform.sockets.setAutoResponse('{"type":"ping"}', '{"type":"pong"}');

    expect(calls.setWebSocketAutoResponse).toHaveBeenCalledTimes(1);
    const pair = calls.setWebSocketAutoResponse.mock.calls[0][0] as FakeRequestResponsePair;
    expect(pair).toBeInstanceOf(FakeRequestResponsePair);
    expect(pair.request).toBe('{"type":"ping"}');
    expect(pair.response).toBe('{"type":"pong"}');
  });

  it("builds background tasks over the object's event lifetime that report to the given logger", async () => {
    const { state, calls, db } = createFakeState();
    const logger = { error: vi.fn() } as unknown as Logger;

    const platform = createDurableObjectSessionPlatform(state, db);
    platform.createBackgroundTasks(logger).submit(() => Promise.reject(new Error("boom")), {
      name: "session.task",
    });

    expect(calls.waitUntil).toHaveBeenCalledTimes(1);
    await calls.waitUntil.mock.calls[0][0];
    expect(logger.error).toHaveBeenCalledWith(
      "background_task.failed",
      expect.objectContaining({ task_name: "session.task" })
    );
  });
});
