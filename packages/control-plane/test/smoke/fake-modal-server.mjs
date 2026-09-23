// @ts-check
/**
 * Shared stand-in for the Modal data plane, for smoke tests and local previews.
 *
 * It answers the control plane's sandbox endpoints and then plays the part of
 * the sandbox: on `api-create-sandbox` it dials the control plane back over a
 * WebSocket with the auth token it was handed, announces itself ready, and
 * replies to a prompt the way the OpenCode bridge does. Everything it knows
 * about the session arrives in the create request, exactly as Modal's does.
 *
 * It is deliberately not a Modal emulator. It implements the endpoints the
 * control plane calls during one session and the four bridge events that
 * carry a turn, so the smoke can assert a prompt round-trip without a cloud.
 *
 * It speaks the canonical protocol: the control plane's test typecheck holds
 * the events it sends to `SandboxEvent` and the commands it handles to
 * `SandboxCommand`. Modal request bodies have no shared type, so the fields it
 * acts on are validated on arrival and a drifted request fails loudly.
 *
 * Reads MODAL_API_SECRET (the same HMAC secret the control plane signs with),
 * PORT, and BRIDGE_REPLY.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { WebSocket } from "ws";

/** @import { IncomingMessage, ServerResponse } from "node:http" */
/** @import { AddressInfo } from "node:net" */
/** @import { SandboxEvent } from "@open-inspect/shared/types/sandbox-events" */
/** @import { SandboxCommand } from "../../src/session/types" */

/**
 * An event as this peer writes it; `send` adds the sandbox envelope.
 * @typedef {SandboxEvent extends infer Event
 *   ? Event extends unknown
 *     ? Omit<Event, "sandboxId" | "timestamp">
 *     : never
 *   : never} BridgeEvent
 */

/**
 * @typedef {object} FakeModalServerOptions
 * @property {string} secret The control plane's MODAL_API_SECRET; every call must be signed with it.
 * @property {number} [port]
 * @property {string} [host]
 * @property {string} [reply]
 * @property {string} [runtimeVersion]
 * @property {number} [heartbeatMs]
 * @property {number} [chunkDelayMs]
 * @property {(event: string, fields?: Record<string, unknown>) => void} [log]
 */

/** @typedef {Awaited<ReturnType<typeof startFakeModalServer>>} FakeModalServer */

/** @param {FakeModalServerOptions} options */
export async function startFakeModalServer({
  port = 0,
  host = "127.0.0.1",
  secret,
  reply = "Acknowledged by the smoke bridge.",
  runtimeVersion = "smoke",
  heartbeatMs = 5000,
  chunkDelayMs = 100,
  log = () => {},
}) {
  const SECRET = secret;
  const BRIDGE_REPLY = reply;
  let closing = false;
  let holdTurns = false;
  /** @type {Map<string, { socket: WebSocket; heartbeat: ReturnType<typeof setInterval> | undefined }>} */
  const bridges = new Map();
  /** @type {Set<ReturnType<typeof setTimeout>>} */
  const timers = new Set();
  /** @type {Map<WebSocket, { finish: () => void; timer: ReturnType<typeof setTimeout> | null }>} */
  const pendingTurns = new Map();
  /**
   * @param {() => void} fn
   * @param {number} ms
   */
  const later = (fn, ms) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!closing) fn();
    }, ms);
    timers.add(timer);
    return timer;
  };
  /** @param {WebSocket} socket */
  const clearTurn = (socket) => {
    const turn = pendingTurns.get(socket);
    if (turn?.timer) {
      clearTimeout(turn.timer);
      timers.delete(turn.timer);
    }
    pendingTurns.delete(socket);
  };

  /** How long a `timestamp.signature` internal token stays acceptable. */
  const TOKEN_VALIDITY_MS = 5 * 60 * 1000;
  /** The control plane persists the sandbox identity before it calls create, but retry anyway. */
  const BRIDGE_CONNECT_ATTEMPTS = 10;
  const BRIDGE_CONNECT_RETRY_MS = 300;

  /** What the driver reads back from `/__smoke/state` to assert on. */
  const state = {
    /** @type {Array<{ sessionId: string; sandboxId: string }>} */
    createRequests: [],
    bridgeConnections: 0,
    generationHandshakes: 0,
    /** @type {Array<{ messageId: string; content: string }>} */
    promptsReceived: [],
    snapshots: 0,
    rejectedTokens: 0,
    preservations: 0,
    restores: 0,
    stops: 0,
    /** @type {string[]} */
    unexpectedRequests: [],
    /** @type {string[]} */
    errors: [],
  };

  /**
   * Verify the control plane's `timestamp.signature` internal token, the
   * MODAL_API_SECRET mechanism `generateInternalToken` produces. Modal itself
   * performs this check, so the smoke proves the secret is wired on both sides.
   * @param {string | undefined} header
   */
  function isValidInternalToken(header) {
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    if (!token) return false;
    const [timestamp, signature] = token.split(".");
    if (
      !timestamp ||
      !signature ||
      !/^\d+$/.test(timestamp) ||
      !/^[a-f0-9]{64}$/.test(signature) ||
      token.split(".").length !== 2
    )
      return false;
    if (Math.abs(Date.now() - Number(timestamp)) > TOKEN_VALIDITY_MS) return false;
    const expected = createHmac("sha256", SECRET).update(timestamp).digest("hex");
    if (expected.length !== signature.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }

  /**
   * @param {ServerResponse} res
   * @param {number} status
   * @param {unknown} body
   */
  function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(payload);
  }

  /**
   * @param {IncomingMessage} req
   * @returns {Promise<unknown>}
   */
  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      /** @type {Buffer[]} */
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("error", reject);
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
        } catch (cause) {
          reject(cause);
        }
      });
    });
  }

  /**
   * A string the control plane's Modal client puts in a request body. A missing
   * one means that contract drifted, so the request fails instead of guessing.
   * @param {unknown} body
   * @param {...string} path
   * @returns {string}
   */
  function requiredString(body, ...path) {
    /** @type {unknown} */
    let value = body;
    for (const key of path)
      value =
        value && typeof value === "object"
          ? /** @type {Record<string, unknown>} */ (value)[key]
          : undefined;
    if (typeof value !== "string" || !value)
      throw new Error(`request carried no ${path.join(".")}`);
    return value;
  }

  /**
   * Play the sandbox for one session: connect, announce ready, answer prompts
   * with a token and an execution_complete, and go away on shutdown.
   * @param {{ sessionId: string; sandboxId: string; controlPlaneUrl: string; authToken: string }} session
   */
  async function runBridge({ sessionId, sandboxId, controlPlaneUrl, authToken }) {
    const wsUrl = `${controlPlaneUrl.replace(/^http/, "ws")}/sessions/${sessionId}/ws?type=sandbox`;
    for (let attempt = 1; attempt <= BRIDGE_CONNECT_ATTEMPTS; attempt++) {
      if (closing) return;
      const connected = await new Promise((resolve) => {
        const socket = new WebSocket(wsUrl, {
          headers: { Authorization: `Bearer ${authToken}`, "X-Sandbox-ID": sandboxId },
        });
        /** @type {{ socket: WebSocket; heartbeat: ReturnType<typeof setInterval> | undefined }} */
        const bridge = { socket, heartbeat: undefined };
        bridges.set(sandboxId, bridge);

        /** @param {BridgeEvent} event */
        const send = (event) =>
          socket.readyState === WebSocket.OPEN &&
          socket.send(JSON.stringify({ sandboxId, timestamp: Date.now() / 1000, ...event }));

        socket.on("open", () => {
          state.bridgeConnections += 1;
          bridge.heartbeat = setInterval(() => send({ type: "heartbeat" }), heartbeatMs);
          log("bridge.connected", { session_id: sessionId, sandbox_id: sandboxId, attempt });
          send({
            type: "ready",
            opencodeSessionId: null,
            harness: "opencode",
            runtimeVersion,
            preservationProtocolVersion: 1,
          });
          resolve(true);
        });

        socket.on("message", (raw) => {
          /** @type {SandboxCommand} */
          let command;
          try {
            command = JSON.parse(raw.toString());
          } catch {
            return;
          }
          if (command.type === "sandbox_generation") {
            state.generationHandshakes += 1;
            log("bridge.generation", { session_id: sessionId, generation: command.generation });
            send({ type: "sandbox_generation_ready", generation: command.generation });
          } else if (command.type === "prompt") {
            const { messageId } = command;
            state.promptsReceived.push({ messageId, content: command.content });
            log("bridge.prompt", { session_id: sessionId, message_id: messageId });
            clearTurn(socket);
            const split = Math.max(1, Math.floor(BRIDGE_REPLY.length / 2));
            send({
              type: "token",
              messageId,
              content: BRIDGE_REPLY.slice(0, split),
            });
            const finish = () => {
              clearTurn(socket);
              send({ type: "token", messageId, content: BRIDGE_REPLY });
              send({ type: "execution_complete", messageId, success: true });
            };
            pendingTurns.set(socket, {
              finish,
              timer: holdTurns ? null : later(finish, chunkDelayMs),
            });
          } else if (command.type === "prepare_preservation") {
            clearTurn(socket);
            state.preservations += 1;
            send({
              type: "preservation_prepared",
              operationId: command.operationId,
              generation: command.generation,
              executionStopped: true,
            });
          } else if (command.type === "shutdown") {
            log("bridge.shutdown", { session_id: sessionId });
            socket.close();
          }
        });

        socket.on("close", (code) => {
          clearInterval(bridge.heartbeat);
          clearTurn(socket);
          if (bridges.get(sandboxId) === bridge) bridges.delete(sandboxId);
          log("bridge.closed", { session_id: sessionId, code });
          resolve(false);
        });

        socket.on("error", (error) => {
          log("bridge.error", { session_id: sessionId, attempt, error: error.message });
          resolve(false);
        });
      });

      if (connected) return;
      await new Promise((resolve) => setTimeout(resolve, BRIDGE_CONNECT_RETRY_MS));
    }
    log("bridge.gave_up", { session_id: sessionId, sandbox_id: sandboxId });
    if (!closing) state.errors.push("Sandbox bridge could not connect");
  }

  /** @type {Set<Promise<void>>} */
  const tasks = new Set();
  /** @param {Parameters<typeof runBridge>[0]} session */
  function connect(session) {
    /** @type {Promise<void>} */
    const task = runBridge(session).finally(() => tasks.delete(task));
    tasks.add(task);
  }

  /** @param {unknown} body */
  async function handleCreateSandbox(body) {
    const sessionId = requiredString(body, "session_id");
    const controlPlaneUrl = requiredString(body, "control_plane_url");
    const authToken = requiredString(body, "sandbox_auth_token");
    // The only optional field: the client sends null when it generated no sandbox ID.
    const sandboxId =
      /** @type {{ sandbox_id?: unknown }} */ (body).sandbox_id === null
        ? `smoke-sandbox-${Date.now()}`
        : requiredString(body, "sandbox_id");
    state.createRequests.push({ sessionId, sandboxId });
    log("create_sandbox", {
      session_id: sessionId,
      sandbox_id: sandboxId,
      control_plane_url: controlPlaneUrl,
    });

    // Dial back only after the response is on the wire, the way a real sandbox
    // boots after Modal has answered.
    later(() => {
      connect({ sessionId, sandboxId, controlPlaneUrl, authToken });
    }, 0);

    return {
      success: true,
      data: { sandbox_id: sandboxId, modal_object_id: `mo-${sandboxId}`, created_at: Date.now() },
    };
  }

  /** @type {Record<string, (body: unknown) => unknown>} */
  const ROUTES = {
    "/api-create-sandbox": handleCreateSandbox,
    "/api-snapshot-sandbox": () => {
      state.snapshots += 1;
      return { success: true, data: { image_id: `smoke-image-${state.snapshots}` } };
    },
    "/api-restore-sandbox": (body) => {
      state.restores += 1;
      const sandboxId = requiredString(body, "sandbox_id");
      // Restore carries the session inside `session_config`, unlike create,
      // which carries it at the root. Reading the wrong one dials
      // `/sessions/undefined/ws`, so fail loudly instead.
      const sessionId = requiredString(body, "session_config", "session_id");
      const controlPlaneUrl = requiredString(body, "control_plane_url");
      const authToken = requiredString(body, "sandbox_auth_token");
      later(() => {
        connect({ sessionId, sandboxId, controlPlaneUrl, authToken });
      }, 0);
      return { success: true, data: { sandbox_id: sandboxId, modal_object_id: `mo-${sandboxId}` } };
    },
    "/api-stop-sandbox": (body) => {
      const sandboxId = requiredString(body, "sandbox_id").replace(/^mo-/, "");
      const bridge = bridges.get(sandboxId);
      if (bridge) {
        clearInterval(bridge.heartbeat);
        clearTurn(bridge.socket);
        bridge.socket.terminate();
        bridges.delete(sandboxId);
      }
      state.stops += 1;
      return { success: true, data: { stopped: true } };
    },
  };

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (path === "/__smoke/state" && req.method === "GET") {
      sendJson(res, 200, {
        ...state,
        activeBridges: bridges.size,
        pendingTurns: pendingTurns.size,
      });
      return;
    }

    const handler = ROUTES[path];
    if (!handler || req.method !== "POST") {
      state.unexpectedRequests.push(`${req.method} ${path}`);
      sendJson(res, 404, { success: false, error: `No stand-in for ${path}` });
      return;
    }

    if (!isValidInternalToken(req.headers.authorization)) {
      state.rejectedTokens += 1;
      log("auth.rejected", { path });
      sendJson(res, 401, { success: false, error: "Invalid internal token" });
      return;
    }

    readJsonBody(req)
      .then(async (body) => sendJson(res, 200, await handler(body)))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        log("request.failed", { path, error: message });
        // A request this peer cannot serve is a fixture failure, never a silent 500.
        state.errors.push(`${path}: ${message}`);
        sendJson(res, 500, { success: false, error: message });
      });
  });

  server.listen(port, host);
  await once(server, "listening");
  const address = /** @type {AddressInfo} */ (server.address());
  /** @type {Promise<void> | undefined} */
  let stopped;
  return {
    origin: `http://${host}:${address.port}`,
    state,
    get activeBridges() {
      return bridges.size;
    },
    holdTurns() {
      holdTurns = true;
    },
    releaseTurns() {
      holdTurns = false;
      for (const turn of [...pendingTurns.values()]) turn.finish();
    },
    close() {
      return (stopped ??= (async () => {
        closing = true;
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        for (const { socket, heartbeat } of bridges.values()) {
          clearInterval(heartbeat);
          clearTurn(socket);
          socket.terminate();
        }
        bridges.clear();
        await Promise.all(tasks);
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      })());
    },
  };
}
