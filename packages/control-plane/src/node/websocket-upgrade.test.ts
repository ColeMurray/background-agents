import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { connect as connectTcp, type AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import type { SqlDatabase, SqlStatement } from "../db/sql-database";
import type { Logger } from "../logger";
import type { SessionWebSocket } from "../platform-ports";
import type { UpgradeDecision } from "../session/connection-authenticator";
import { createSessionUpgradeHandler, type UpgradeServingRuntime } from "./websocket-upgrade";

function fakeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

/** A global store whose session index knows `known`. */
function indexDatabase(known: Set<string>): SqlDatabase {
  return {
    prepare() {
      let bound: unknown[] = [];
      const statement: SqlStatement = {
        bind: (...values) => {
          bound = values;
          return statement;
        },
        first: async <T>() => (known.has(String(bound[0])) ? ({ ok: 1 } as T) : null),
        all: async <T>() => ({ results: [] as T[], meta: { changes: 0 } }),
        run: async <T>() => ({ results: [] as T[], meta: { changes: 0 } }),
      };
      return statement;
    },
    batch: async () => [],
  };
}

function runtimeDeciding(decide: (request: Request) => UpgradeDecision): UpgradeServingRuntime {
  return {
    upgrades: { authorize: vi.fn(async (request: Request) => decide(request)) },
    log: fakeLogger(),
  };
}

function accept(attach: (ws: SessionWebSocket) => void | Promise<void>): UpgradeDecision {
  return { kind: "accept", role: "client", attach: async (ws) => attach(ws) };
}

/** The `ws` socket behind the port, as a test's attachment sees it. */
function asNodeSocket(ws: SessionWebSocket): NodeWebSocket {
  return ws as unknown as NodeWebSocket;
}

function rejected(ws: NodeWebSocket): Promise<string> {
  return new Promise((resolve) => ws.once("error", (error) => resolve(error.message)));
}

/** Send a raw upgrade request and collect the server's answer, for requests a client library would not send. */
function rawUpgrade(port: number, requestText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp(port, "127.0.0.1");
    let received = "";
    socket.on("connect", () => socket.write(requestText));
    socket.on("data", (chunk) => {
      received += chunk.toString();
    });
    socket.on("close", () => resolve(received));
    socket.on("error", reject);
  });
}

describe("createSessionUpgradeHandler", () => {
  const known = new Set(["s1", "s2"]);
  let indexFailure: Error | null = null;
  const runtimes = new Map<string, UpgradeServingRuntime>();
  let log: Logger;
  let server: Server;
  let port: number;
  const clients: NodeWebSocket[] = [];

  const connect = (path: string): NodeWebSocket => {
    const ws = new NodeWebSocket(`ws://127.0.0.1:${port}${path}`);
    clients.push(ws);
    return ws;
  };

  beforeEach(async () => {
    log = fakeLogger();
    runtimes.clear();
    indexFailure = null;
    const index = indexDatabase(known);
    const handler = createSessionUpgradeHandler({
      db: {
        prepare: (query) => {
          if (indexFailure) throw indexFailure;
          return index.prepare(query);
        },
        batch: index.batch,
      },
      runtimes: {
        withRuntimeIfPresent: async (sessionId, use) => {
          const runtime = runtimes.get(sessionId);
          return runtime ? use(runtime) : undefined;
        },
      },
      log,
    });
    server = createServer((_request, response) => response.writeHead(426).end());
    server.on("upgrade", (request, socket, head) => void handler(request, socket, head));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    for (const ws of clients.splice(0)) ws.terminate();
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  });

  it("answers 400 on any path but a session's", async () => {
    expect(await rejected(connect("/sessions/s1/events"))).toBe("Unexpected server response: 400");
    expect(log.warn).toHaveBeenCalledWith(
      "Invalid WebSocket path",
      expect.objectContaining({ event: "ws.invalid_path" })
    );
  });

  it("answers 400 to an upgrade whose Host makes no URL", async () => {
    const answer = await rawUpgrade(
      port,
      "GET /sessions/s1/ws HTTP/1.1\r\nHost: [::1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );
    expect(answer.startsWith("HTTP/1.1 400 Bad Request")).toBe(true);
    expect(answer.endsWith("Invalid WebSocket request")).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      "Invalid WebSocket request",
      expect.objectContaining({ event: "ws.invalid_request" })
    );
  });

  it("answers 500 and logs when the path itself fails, so nothing rejects past it", async () => {
    indexFailure = new Error("index unavailable");
    expect(await rejected(connect("/sessions/s1/ws"))).toBe("Unexpected server response: 500");
    expect(log.error).toHaveBeenCalledWith(
      "WebSocket upgrade failed",
      expect.objectContaining({ event: "ws.upgrade_failed", error: indexFailure })
    );
  });

  it("answers 404 for a session the index does not know, without opening a runtime", async () => {
    const authorize = vi.fn();
    runtimes.set("nope", { upgrades: { authorize }, log: fakeLogger() });
    expect(await rejected(connect("/sessions/nope/ws"))).toBe("Unexpected server response: 404");
    expect(authorize).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      "WebSocket session not found",
      expect.objectContaining({ session_id: "nope", sql_query_count: 1 })
    );
  });

  it("answers 404 when the index knows the session but nothing is behind it", async () => {
    expect(await rejected(connect("/sessions/s2/ws"))).toBe("Unexpected server response: 404");
  });

  it("writes the session's rejection as the handshake's status", async () => {
    runtimes.set(
      "s1",
      runtimeDeciding(() => ({
        kind: "reject",
        response: new Response("Unauthorized", { status: 401 }),
      }))
    );
    expect(await rejected(connect("/sessions/s1/ws"))).toBe("Unexpected server response: 401");
  });

  it("hands the session the upgrade as a request with its URL and headers", async () => {
    const seen: Request[] = [];
    runtimes.set(
      "s1",
      runtimeDeciding((request) => {
        seen.push(request);
        return { kind: "reject", response: new Response(null, { status: 403 }) };
      })
    );
    await rejected(connect("/sessions/s1/ws?token=abc"));
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url).toBe(`http://127.0.0.1:${port}/sessions/s1/ws?token=abc`);
    expect(seen[0].headers.get("upgrade")).toBe("websocket");
    expect(seen[0].headers.get("sec-websocket-key")).toBeTruthy();
  });

  it("completes an accepted upgrade and the runtime exchanges messages on the socket", async () => {
    runtimes.set(
      "s1",
      runtimeDeciding(() =>
        accept((ws) => {
          asNodeSocket(ws).on("message", (data) => ws.send(`echo:${String(data)}`));
        })
      )
    );
    const ws = connect("/sessions/s1/ws");
    await once(ws, "open");
    ws.send("hi");
    const [reply] = await once(ws, "message");
    expect(String(reply)).toBe("echo:hi");
    expect(log.info).toHaveBeenCalledWith(
      "WebSocket upgrade",
      expect.objectContaining({ event: "ws.connect", session_id: "s1" })
    );
  });

  it("holds a frame sent on the 101 until the runtime has attached", async () => {
    let attachNow!: () => void;
    const attached = new Promise<void>((resolve) => {
      attachNow = resolve;
    });
    runtimes.set(
      "s1",
      runtimeDeciding(() =>
        accept(async (ws) => {
          await attached;
          asNodeSocket(ws).on("message", (data) => ws.send(`echo:${String(data)}`));
        })
      )
    );
    const ws = connect("/sessions/s1/ws");
    await once(ws, "open");
    ws.send("early");
    // Long enough for the frame to reach the server while attachment waits.
    await new Promise((resolve) => setTimeout(resolve, 50));
    attachNow();
    const [reply] = await once(ws, "message");
    expect(String(reply)).toBe("echo:early");
  });

  it("closes the socket with 1011 when attachment fails", async () => {
    const runtime = runtimeDeciding(() =>
      accept(() => {
        throw new Error("no room");
      })
    );
    runtimes.set("s1", runtime);
    const ws = connect("/sessions/s1/ws");
    const [code, reason] = await once(ws, "close");
    expect(code).toBe(1011);
    expect(String(reason)).toBe("WebSocket upgrade failed");
    expect(runtime.log.error).toHaveBeenCalledWith(
      "WebSocket upgrade failed",
      expect.objectContaining({ ws_type: "client" })
    );
  });
});
