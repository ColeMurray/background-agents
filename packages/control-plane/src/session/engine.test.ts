import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import { SessionConnectionLifecycle } from "./connection-lifecycle";
import { SessionInternalPaths } from "./contracts";
import { SessionEngine } from "./engine";
import { SessionHttpDispatcher, type SessionHttpDispatcherDeps } from "./http/dispatcher";
import { SessionSocketProtocol, type SessionSocketProtocolDeps } from "./socket-protocol";

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
  let currentClient: TestClient | null = client;
  let connectionKind: "client" | "sandbox" = "client";
  let now = 1000;
  const monotonicTimes = [0, 2, 5, 8];
  const classifyConnection = vi.fn(() =>
    connectionKind === "sandbox"
      ? { kind: "sandbox" as const, sandboxId: "sandbox-1" }
      : { kind: "client" as const, wsId: "ws-1" }
  );
  const initialize = vi.fn();

  const httpDeps: SessionHttpDispatcherDeps = {
    getLogger: () => log,
    routes: [
      {
        method: "GET",
        path: SessionInternalPaths.state,
        handler: vi.fn(async () => new Response("state", { status: 200 })),
      },
    ],
    handleWebSocketUpgrade: vi.fn(async () => new Response(null, { status: 200 })),
    monotonicNow: vi.fn(() => monotonicTimes.shift() ?? 8),
  };
  const protocolDeps: SessionSocketProtocolDeps<string, TestClient> = {
    getLogger: () => log,
    classifyConnection,
    send: vi.fn(() => true),
    getClient: vi.fn(() => currentClient),
    handleSubscribe: vi.fn(async () => undefined),
    handlePrompt: vi.fn(async () => undefined),
    cancelPrompt: vi.fn(async () => undefined),
    stopExecution: vi.fn(async () => undefined),
    handleTyping: vi.fn(async () => undefined),
    updatePresence: vi.fn(),
    getHistoryPage: vi.fn(() => ({ items: [], hasMore: false, cursor: null })),
    processSandboxEvent: vi.fn(async () => undefined),
    now: () => now,
  };
  const connectionDeps = {
    getLogger: () => log,
    classifyConnection,
    close: vi.fn(),
    closeOnError: vi.fn(),
    clearSandboxConnectionIfMatch: vi.fn(() => true),
    getSandboxStatus: vi.fn((): "ready" => "ready"),
    scheduleDisconnectCheck: vi.fn(async () => undefined),
    removeClient: vi.fn(() => client),
    hasAuthenticatedParticipant: vi.fn(() => false),
    broadcastPresence: vi.fn(),
    broadcast: vi.fn(),
  };
  const handleAlarm = vi.fn(async () => undefined);

  const engine = new SessionEngine({
    initialize,
    http: new SessionHttpDispatcher(httpDeps),
    socketProtocol: new SessionSocketProtocol(protocolDeps),
    connectionLifecycle: new SessionConnectionLifecycle(connectionDeps),
    handleAlarm,
  });

  return {
    engine,
    initialize,
    httpDeps,
    protocolDeps,
    connectionDeps,
    handleAlarm,
    client,
    log,
    requestLog,
    setClient: (value: TestClient | null) => {
      currentClient = value;
    },
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
  it("initializes, dispatches HTTP routes, and preserves request correlation metrics", async () => {
    const { engine, initialize, httpDeps, log, requestLog } = createHarness();
    const response = await engine.fetch(
      new Request(`https://session${SessionInternalPaths.state}`, {
        headers: { "x-trace-id": "trace-1", "x-request-id": "request-1" },
      })
    );

    expect(await response.text()).toBe("state");
    expect(initialize).toHaveBeenCalledOnce();
    expect(log.child).toHaveBeenCalledWith({
      trace_id: "trace-1",
      request_id: "request-1",
    });
    expect(httpDeps.routes[0].handler).toHaveBeenCalledWith(
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

  it("returns 404 for an unmatched HTTP route", async () => {
    const { engine, initialize, httpDeps } = createHarness();

    const response = await engine.fetch(new Request("https://session/not-a-session-route"));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
    expect(initialize).toHaveBeenCalledOnce();
    expect(httpDeps.routes[0].handler).not.toHaveBeenCalled();
  });

  it("preserves correlated invalid-prompt errors", async () => {
    const { engine, protocolDeps } = createHarness();
    await engine.webSocketMessage(
      "client",
      JSON.stringify({ type: "prompt", content: "", clientRequestId: "request-1" })
    );

    expect(protocolDeps.send).toHaveBeenCalledWith("client", {
      type: "error",
      code: "INVALID_PROMPT",
      message: "Invalid prompt",
      clientRequestId: "request-1",
    });
  });

  it("routes ping without requiring an authenticated client", async () => {
    const { engine, protocolDeps, setClient } = createHarness();
    setClient(null);

    await engine.webSocketMessage("client", JSON.stringify({ type: "ping" }));

    expect(protocolDeps.send).toHaveBeenCalledWith("client", { type: "pong", timestamp: 1000 });
    expect(protocolDeps.getClient).not.toHaveBeenCalled();
  });

  it("routes subscribe without requiring an authenticated client", async () => {
    const { engine, protocolDeps, setClient } = createHarness();
    setClient(null);
    const message = { type: "subscribe" as const, token: "token", clientId: "client-1" };

    await engine.webSocketMessage("client", JSON.stringify(message));

    expect(protocolDeps.handleSubscribe).toHaveBeenCalledWith("client", message);
    expect(protocolDeps.getClient).not.toHaveBeenCalled();
  });

  it.each([
    {
      type: "prompt",
      message: { type: "prompt", content: "work", clientRequestId: "request-1" },
      callback: "handlePrompt",
    },
    {
      type: "cancel_prompt",
      message: { type: "cancel_prompt", messageId: "message-1", clientRequestId: "request-1" },
      callback: "cancelPrompt",
    },
    { type: "stop", message: { type: "stop" }, callback: "stopExecution" },
    { type: "typing", message: { type: "typing" }, callback: "handleTyping" },
    {
      type: "presence",
      message: { type: "presence", status: "idle" },
      callback: "updatePresence",
    },
  ])("routes authenticated $type messages", async ({ message, callback }) => {
    const { engine, protocolDeps } = createHarness();

    await engine.webSocketMessage("client", JSON.stringify(message));

    expect(protocolDeps[callback as keyof typeof protocolDeps]).toHaveBeenCalledOnce();
  });

  it("drops authenticated-only commands when no client mapping exists", async () => {
    const { engine, protocolDeps, setClient } = createHarness();
    setClient(null);

    await engine.webSocketMessage("client", JSON.stringify({ type: "stop" }));

    expect(protocolDeps.stopExecution).not.toHaveBeenCalled();
  });

  it("routes fetch_history and enforces throttling with the injected clock", async () => {
    const { engine, protocolDeps, setNow } = createHarness();
    const cursor = { timestamp: 10, id: "event-1", sequence: 2 };

    await engine.webSocketMessage("client", JSON.stringify({ type: "fetch_history", cursor }));
    setNow(1100);
    await engine.webSocketMessage("client", JSON.stringify({ type: "fetch_history", cursor }));

    expect(protocolDeps.getHistoryPage).toHaveBeenCalledOnce();
    expect(protocolDeps.send).toHaveBeenCalledWith("client", {
      type: "history_page",
      items: [],
      hasMore: false,
      cursor: null,
    });
    expect(protocolDeps.send).toHaveBeenCalledWith("client", {
      type: "error",
      code: "RATE_LIMITED",
      message: "Too many requests",
    });
  });

  it("parses and routes sandbox events without exposing a socket type", async () => {
    const { engine, protocolDeps, setConnectionKind } = createHarness();
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

    expect(protocolDeps.processSandboxEvent).toHaveBeenCalledWith({
      type: "heartbeat",
      sandboxId: "sandbox-1",
      timestamp: 1000,
      status: "ready",
    });
  });

  it("schedules sandbox reconnect checks and always reciprocates close", async () => {
    const { engine, connectionDeps, setConnectionKind } = createHarness();
    setConnectionKind("sandbox");

    await engine.webSocketClose("sandbox", 1006, "lost", false);

    expect(connectionDeps.scheduleDisconnectCheck).toHaveBeenCalledOnce();
    expect(connectionDeps.close).toHaveBeenCalledWith("sandbox", 1006, "lost");
  });

  it("ignores replaced sandbox closes but still completes the close handshake", async () => {
    const { engine, connectionDeps, setConnectionKind } = createHarness();
    setConnectionKind("sandbox");
    connectionDeps.clearSandboxConnectionIfMatch.mockReturnValue(false);

    await engine.webSocketClose("sandbox", 1000, "replaced", true);

    expect(connectionDeps.scheduleDisconnectCheck).not.toHaveBeenCalled();
    expect(connectionDeps.close).toHaveBeenCalledWith("sandbox", 1000, "replaced");
  });

  it("refreshes presence when a closing client participant remains connected", async () => {
    const { engine, connectionDeps } = createHarness();
    connectionDeps.hasAuthenticatedParticipant.mockReturnValue(true);

    await engine.webSocketClose("client", 1000, "closed", true);

    expect(connectionDeps.broadcastPresence).toHaveBeenCalledOnce();
    expect(connectionDeps.broadcast).not.toHaveBeenCalled();
    expect(connectionDeps.close).toHaveBeenCalledWith("client", 1000, "closed");
  });

  it("broadcasts presence_leave when a participant's last client closes", async () => {
    const { engine, connectionDeps } = createHarness();

    await engine.webSocketClose("client", 1000, "closed", true);

    expect(connectionDeps.broadcast).toHaveBeenCalledWith({
      type: "presence_leave",
      userId: "user-1",
    });
    expect(connectionDeps.broadcastPresence).not.toHaveBeenCalled();
    expect(connectionDeps.close).toHaveBeenCalledWith("client", 1000, "closed");
  });

  it("delegates alarms after initialization", async () => {
    const { engine, initialize, handleAlarm } = createHarness();

    await engine.alarm();

    expect(initialize).toHaveBeenCalledOnce();
    expect(handleAlarm).toHaveBeenCalledOnce();
  });
});
