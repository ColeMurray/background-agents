import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import { SessionInternalPaths } from "./contracts";
import { SessionEngine, type SessionEngineDeps } from "./engine";

interface TestClient {
  participantId: string;
  userId: string;
  lastFetchHistoryAt?: number;
}

function createHarness() {
  const requestLog = createLogger();
  const log = createLogger();
  log.child.mockReturnValue(requestLog);
  const client: TestClient = { participantId: "participant-1", userId: "user-1" };
  let connectionKind: "client" | "sandbox" = "client";
  let now = 1000;
  const monotonicTimes = [0, 2, 5, 8];

  const deps: SessionEngineDeps<string, TestClient> = {
    initialize: vi.fn(),
    getLogger: () => log,
    routes: [
      {
        method: "GET",
        path: SessionInternalPaths.state,
        handler: vi.fn(async () => new Response("state", { status: 200 })),
      },
    ],
    handleWebSocketUpgrade: vi.fn(async () => new Response(null, { status: 200 })),
    classifyConnection: vi.fn(() =>
      connectionKind === "sandbox"
        ? { kind: "sandbox" as const, sandboxId: "sandbox-1" }
        : { kind: "client" as const, wsId: "ws-1" }
    ),
    send: vi.fn(() => true),
    close: vi.fn(),
    closeOnError: vi.fn(),
    getClient: vi.fn(() => client),
    handleSubscribe: vi.fn(async () => undefined),
    handlePrompt: vi.fn(async () => undefined),
    cancelPrompt: vi.fn(async () => undefined),
    stopExecution: vi.fn(async () => undefined),
    handleTyping: vi.fn(async () => undefined),
    updatePresence: vi.fn(),
    getHistoryPage: vi.fn(() => ({ items: [], hasMore: false, cursor: null })),
    processSandboxEvent: vi.fn(async () => undefined),
    clearSandboxConnectionIfMatch: vi.fn(() => true),
    getSandboxStatus: vi.fn((): "ready" => "ready"),
    scheduleDisconnectCheck: vi.fn(async () => undefined),
    removeClient: vi.fn(() => client),
    hasAuthenticatedParticipant: vi.fn(() => false),
    broadcastPresence: vi.fn(),
    broadcast: vi.fn(),
    handleAlarm: vi.fn(async () => undefined),
    now: () => now,
    monotonicNow: vi.fn(() => monotonicTimes.shift() ?? 8),
  };

  return {
    engine: new SessionEngine(deps),
    deps,
    client,
    log,
    requestLog,
    setConnectionKind: (kind: "client" | "sandbox") => {
      connectionKind = kind;
    },
    setNow: (value: number) => {
      now = value;
    },
  };
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger & {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    child: ReturnType<typeof vi.fn>;
  };
}

describe("SessionEngine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("initializes, dispatches HTTP routes, and preserves request correlation metrics", async () => {
    const { engine, deps, log, requestLog } = createHarness();
    const response = await engine.fetch(
      new Request(`https://session${SessionInternalPaths.state}`, {
        headers: { "x-trace-id": "trace-1", "x-request-id": "request-1" },
      })
    );

    expect(await response.text()).toBe("state");
    expect(deps.initialize).toHaveBeenCalledOnce();
    expect(log.child).toHaveBeenCalledWith({
      trace_id: "trace-1",
      request_id: "request-1",
    });
    expect(deps.routes[0].handler).toHaveBeenCalledWith(
      expect.any(Request),
      expect.any(URL),
      requestLog
    );
    expect(requestLog.info).toHaveBeenCalledWith("do.request", {
      event: "do.request",
      http_method: "GET",
      http_path: SessionInternalPaths.state,
      http_status: 200,
      duration_ms: 8,
      init_ms: 2,
      handler_ms: 3,
      outcome: "success",
    });
  });

  it("preserves correlated invalid-prompt errors", async () => {
    const { engine, deps } = createHarness();
    await engine.webSocketMessage(
      "client",
      JSON.stringify({ type: "prompt", content: "", clientRequestId: "request-1" })
    );

    expect(deps.send).toHaveBeenCalledWith("client", {
      type: "error",
      code: "INVALID_PROMPT",
      message: "Invalid prompt",
      clientRequestId: "request-1",
    });
  });

  it("routes client commands and enforces history throttling with the injected clock", async () => {
    const { engine, deps, client, setNow } = createHarness();
    const cursor = { timestamp: 10, id: "event-1", sequence: 2 };

    await engine.webSocketMessage(
      "client",
      JSON.stringify({
        type: "prompt",
        content: "work",
        clientRequestId: "request-1",
      })
    );
    await engine.webSocketMessage("client", JSON.stringify({ type: "fetch_history", cursor }));
    setNow(1100);
    await engine.webSocketMessage("client", JSON.stringify({ type: "fetch_history", cursor }));

    expect(deps.handlePrompt).toHaveBeenCalledWith(
      "client",
      client,
      expect.objectContaining({ content: "work", clientRequestId: "request-1" })
    );
    expect(deps.getHistoryPage).toHaveBeenCalledOnce();
    expect(deps.send).toHaveBeenCalledWith("client", {
      type: "history_page",
      items: [],
      hasMore: false,
      cursor: null,
    });
    expect(deps.send).toHaveBeenCalledWith("client", {
      type: "error",
      code: "RATE_LIMITED",
      message: "Too many requests",
    });
  });

  it("parses and routes sandbox events without exposing a socket type", async () => {
    const { engine, deps, setConnectionKind } = createHarness();
    setConnectionKind("sandbox");

    await engine.webSocketMessage(
      "sandbox",
      JSON.stringify({
        type: "heartbeat",
        sandboxId: "sandbox-1",
        timestamp: 1000,
        status: "ready",
      })
    );

    expect(deps.processSandboxEvent).toHaveBeenCalledWith({
      type: "heartbeat",
      sandboxId: "sandbox-1",
      timestamp: 1000,
      status: "ready",
    });
  });

  it("schedules sandbox reconnect checks and always reciprocates close", async () => {
    const { engine, deps, setConnectionKind } = createHarness();
    setConnectionKind("sandbox");

    await engine.webSocketClose("sandbox", 1006, "lost", false);

    expect(deps.scheduleDisconnectCheck).toHaveBeenCalledOnce();
    expect(deps.close).toHaveBeenCalledWith("sandbox", 1006, "lost");
  });

  it("ignores replaced sandbox closes but still completes the close handshake", async () => {
    const { engine, deps, setConnectionKind } = createHarness();
    setConnectionKind("sandbox");
    vi.mocked(deps.clearSandboxConnectionIfMatch).mockReturnValue(false);

    await engine.webSocketClose("sandbox", 1000, "replaced", true);

    expect(deps.scheduleDisconnectCheck).not.toHaveBeenCalled();
    expect(deps.close).toHaveBeenCalledWith("sandbox", 1000, "replaced");
  });

  it("delegates alarms after initialization", async () => {
    const { engine, deps } = createHarness();

    await engine.alarm();

    expect(deps.initialize).toHaveBeenCalledOnce();
    expect(deps.handleAlarm).toHaveBeenCalledOnce();
  });
});
