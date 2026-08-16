import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import { SessionInternalPaths } from "./contracts";
import { SessionDisconnectHandler } from "./disconnect-handler";
import { SessionHttpDispatcher, type SessionHttpDispatcherDeps } from "./http/dispatcher";
import {
  SessionMessageRouter,
  type SessionClientCommands,
  type SessionMessageRouterDeps,
} from "./message-router";
import type { Clock, SandboxDisconnectMonitor, SessionBroadcaster, SocketRegistry } from "./ports";
import { SessionServer } from "./server";

interface TestClient {
  participantId: string;
  userId: string;
  lastFetchHistoryAtMs?: number;
}

function createHarness() {
  const requestLog = createLogger();
  const log = createLogger();
  log.child.mockReturnValue(requestLog);
  const client: TestClient = { participantId: "participant-1", userId: "user-1" };
  let currentClient: TestClient | null = client;
  let connectionKind: "client" | "sandbox" = "client";
  let now = 1000;
  const monotonicTimes = [0, 2, 5, 8, 10];
  const ensureInitialized = vi.fn();
  const clock: Clock = {
    nowMs: () => now,
    monotonicNowMs: vi.fn(() => {
      const nowMs = monotonicTimes.shift();
      if (nowMs === undefined) throw new Error("Unexpected monotonic clock read");
      return nowMs;
    }),
  };
  const classifyConnection = vi.fn(() =>
    connectionKind === "sandbox"
      ? { kind: "sandbox" as const, sandboxId: "sandbox-1" }
      : { kind: "client" as const, wsId: "ws-1" }
  );
  const sockets: SocketRegistry<string, TestClient> = {
    classify: classifyConnection,
    send: vi.fn(() => true),
    getClient: vi.fn(() => currentClient),
    close: vi.fn(),
    clearSandboxIfMatch: vi.fn(() => true),
    removeClient: vi.fn(() => client),
    hasParticipant: vi.fn(() => false),
  };
  const clientCommands: SessionClientCommands<string, TestClient> = {
    subscribe: vi.fn(async () => undefined),
    submitPrompt: vi.fn(async () => undefined),
    cancelPrompt: vi.fn(async () => undefined),
    stopExecution: vi.fn(async () => undefined),
    notifyTyping: vi.fn(async () => undefined),
    updatePresence: vi.fn(),
    getHistoryPage: vi.fn(() => ({ items: [], hasMore: false, cursor: null })),
  };
  const sandbox: SandboxDisconnectMonitor = {
    getStatus: vi.fn((): "ready" => "ready"),
    scheduleCheck: vi.fn(async () => undefined),
  };
  const broadcaster: SessionBroadcaster = {
    broadcastPresence: vi.fn(),
    broadcast: vi.fn(),
  };

  const httpDeps: SessionHttpDispatcherDeps = {
    ensureInitialized,
    getLogger: () => log,
    routes: [
      {
        method: "GET",
        path: SessionInternalPaths.state,
        handler: vi.fn(async () => new Response("state", { status: 200 })),
      },
    ],
    handleWebSocketUpgrade: vi.fn(async () => new Response(null, { status: 200 })),
    clock,
  };
  const messageDeps: SessionMessageRouterDeps<string, TestClient> = {
    getLogger: () => log,
    sockets,
    clientCommands,
    processSandboxEvent: vi.fn(async () => undefined),
    clock,
  };
  const disconnectDeps = {
    getLogger: () => log,
    sockets,
    sandbox,
    broadcaster,
  };
  const handleScheduledDeadline = vi.fn(async () => undefined);

  const server = new SessionServer({
    ensureInitialized,
    http: new SessionHttpDispatcher(httpDeps),
    messages: new SessionMessageRouter(messageDeps),
    disconnects: new SessionDisconnectHandler(disconnectDeps),
    handleScheduledDeadline,
  });

  return {
    server,
    ensureInitialized,
    httpDeps,
    messageDeps,
    sockets,
    clientCommands,
    sandbox,
    broadcaster,
    handleScheduledDeadline,
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

describe("SessionServer", () => {
  it("initializes, dispatches HTTP routes, and preserves request correlation metrics", async () => {
    const { server, ensureInitialized, httpDeps, log, requestLog } = createHarness();
    const response = await server.onRequest(
      new Request(`https://session${SessionInternalPaths.state}`, {
        headers: { "x-trace-id": "trace-1", "x-request-id": "request-1" },
      })
    );

    expect(await response.text()).toBe("state");
    expect(ensureInitialized).toHaveBeenCalledOnce();
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
      duration_ms: 10,
      init_ms: 2,
      handler_ms: 3,
      outcome: "success",
    });
  });

  it("returns 404 for an unmatched HTTP route", async () => {
    const { server, ensureInitialized, httpDeps } = createHarness();

    const response = await server.onRequest(new Request("https://session/not-a-session-route"));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
    expect(ensureInitialized).toHaveBeenCalledOnce();
    expect(httpDeps.routes[0].handler).not.toHaveBeenCalled();
  });

  it("preserves correlated invalid-prompt errors", async () => {
    const { server, sockets } = createHarness();
    await server.onMessage(
      "client",
      JSON.stringify({ type: "prompt", content: "", clientRequestId: "request-1" })
    );

    expect(sockets.send).toHaveBeenCalledWith("client", {
      type: "error",
      code: "INVALID_PROMPT",
      message: "Invalid prompt",
      clientRequestId: "request-1",
    });
  });

  it("routes ping without requiring an authenticated client", async () => {
    const { server, sockets, setClient } = createHarness();
    setClient(null);

    await server.onMessage("client", JSON.stringify({ type: "ping" }));

    expect(sockets.send).toHaveBeenCalledWith("client", { type: "pong", timestamp: 1000 });
    expect(sockets.getClient).not.toHaveBeenCalled();
  });

  it("routes subscribe without requiring an authenticated client", async () => {
    const { server, sockets, clientCommands, setClient } = createHarness();
    setClient(null);
    const message = { type: "subscribe" as const, token: "token", clientId: "client-1" };

    await server.onMessage("client", JSON.stringify(message));

    expect(clientCommands.subscribe).toHaveBeenCalledWith("client", message);
    expect(sockets.getClient).not.toHaveBeenCalled();
  });

  it.each([
    {
      type: "prompt",
      message: { type: "prompt", content: "work", clientRequestId: "request-1" },
      callback: "submitPrompt",
    },
    {
      type: "cancel_prompt",
      message: { type: "cancel_prompt", messageId: "message-1", clientRequestId: "request-1" },
      callback: "cancelPrompt",
    },
    { type: "stop", message: { type: "stop" }, callback: "stopExecution" },
    { type: "typing", message: { type: "typing" }, callback: "notifyTyping" },
    {
      type: "presence",
      message: { type: "presence", status: "idle" },
      callback: "updatePresence",
    },
  ])("routes authenticated $type messages", async ({ message, callback }) => {
    const { server, clientCommands } = createHarness();

    await server.onMessage("client", JSON.stringify(message));

    expect(clientCommands[callback as keyof typeof clientCommands]).toHaveBeenCalledOnce();
  });

  it("drops authenticated-only commands when no client mapping exists", async () => {
    const { server, clientCommands, setClient } = createHarness();
    setClient(null);

    await server.onMessage("client", JSON.stringify({ type: "stop" }));

    expect(clientCommands.stopExecution).not.toHaveBeenCalled();
  });

  it("routes fetch_history and enforces throttling with the injected clock", async () => {
    const { server, sockets, clientCommands, setNow } = createHarness();
    const cursor = { timestamp: 10, id: "event-1", sequence: 2 };

    setNow(0);
    await server.onMessage("client", JSON.stringify({ type: "fetch_history", cursor }));
    setNow(100);
    await server.onMessage("client", JSON.stringify({ type: "fetch_history", cursor }));

    expect(clientCommands.getHistoryPage).toHaveBeenCalledOnce();
    expect(sockets.send).toHaveBeenCalledWith("client", {
      type: "history_page",
      items: [],
      hasMore: false,
      cursor: null,
    });
    expect(sockets.send).toHaveBeenCalledWith("client", {
      type: "error",
      code: "RATE_LIMITED",
      message: "Too many requests",
    });
  });

  it("parses and routes sandbox events without exposing a socket type", async () => {
    const { server, messageDeps, setConnectionKind } = createHarness();
    setConnectionKind("sandbox");

    await server.onMessage(
      "sandbox",
      JSON.stringify({
        type: "heartbeat",
        sandboxId: "sandbox-1",
        timestamp: 1000,
        status: "ready",
      })
    );

    expect(messageDeps.processSandboxEvent).toHaveBeenCalledWith({
      type: "heartbeat",
      sandboxId: "sandbox-1",
      timestamp: 1000,
      status: "ready",
    });
  });

  it("schedules sandbox reconnect checks and always reciprocates close", async () => {
    const { server, sockets, sandbox, setConnectionKind } = createHarness();
    setConnectionKind("sandbox");

    await server.onClose("sandbox", 1006, "lost", false);

    expect(sandbox.scheduleCheck).toHaveBeenCalledOnce();
    expect(sockets.close).toHaveBeenCalledWith("sandbox", 1006, "lost");
  });

  it("ignores replaced sandbox closes but still completes the close handshake", async () => {
    const { server, sockets, sandbox, setConnectionKind } = createHarness();
    setConnectionKind("sandbox");
    vi.mocked(sockets.clearSandboxIfMatch).mockReturnValue(false);

    await server.onClose("sandbox", 1000, "replaced", true);

    expect(sandbox.scheduleCheck).not.toHaveBeenCalled();
    expect(sockets.close).toHaveBeenCalledWith("sandbox", 1000, "replaced");
  });

  it("refreshes presence when a closing client participant remains connected", async () => {
    const { server, sockets, broadcaster } = createHarness();
    vi.mocked(sockets.hasParticipant).mockReturnValue(true);

    await server.onClose("client", 1000, "closed", true);

    expect(broadcaster.broadcastPresence).toHaveBeenCalledOnce();
    expect(broadcaster.broadcast).not.toHaveBeenCalled();
    expect(sockets.close).toHaveBeenCalledWith("client", 1000, "closed");
  });

  it("broadcasts presence_leave when a participant's last client closes", async () => {
    const { server, sockets, broadcaster } = createHarness();

    await server.onClose("client", 1000, "closed", true);

    expect(broadcaster.broadcast).toHaveBeenCalledWith({
      type: "presence_leave",
      userId: "user-1",
    });
    expect(broadcaster.broadcastPresence).not.toHaveBeenCalled();
    expect(sockets.close).toHaveBeenCalledWith("client", 1000, "closed");
  });

  it("delegates alarms after initialization", async () => {
    const { server, ensureInitialized, handleScheduledDeadline } = createHarness();

    await server.onScheduledDeadline();

    expect(ensureInitialized).toHaveBeenCalledOnce();
    expect(handleScheduledDeadline).toHaveBeenCalledOnce();
  });
});
