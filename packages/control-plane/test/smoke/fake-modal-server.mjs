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
 * Reads MODAL_API_SECRET (the same HMAC secret the control plane signs with),
 * PORT, and BRIDGE_REPLY.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { WebSocket } from "ws";

export async function startFakeModalServer({
  port = 0,
  host = "127.0.0.1",
  secret,
  reply = "Acknowledged by the smoke bridge.",
  runtimeVersion = "smoke",
  heartbeatMs = 5000,
  chunkDelayMs = 100,
  log = () => {},
} = {}) {
  const SECRET = secret;
  const BRIDGE_REPLY = reply;
  let closing = false;
  let holdTurns = false;
  const bridges = new Map();
  const timers = new Set();
  const pendingTurns = new Map();
  const later = (fn, ms) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!closing) fn();
    }, ms);
    timers.add(timer);
    return timer;
  };
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
    createRequests: [],
    bridgeConnections: 0,
    generationHandshakes: 0,
    promptsReceived: [],
    snapshots: 0,
    rejectedTokens: 0,
    preservations: 0,
    restores: 0,
    stops: 0,
    unexpectedRequests: [],
    errors: [],
  };

  /**
   * Verify the control plane's `timestamp.signature` internal token, the
   * MODAL_API_SECRET mechanism `generateInternalToken` produces. Modal itself
   * performs this check, so the smoke proves the secret is wired on both sides.
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

  function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(payload);
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
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
   * Play the sandbox for one session: connect, announce ready, answer prompts
   * with a token and an execution_complete, and go away on shutdown.
   */
  async function runBridge({ sessionId, sandboxId, controlPlaneUrl, authToken }) {
    const wsUrl = `${controlPlaneUrl.replace(/^http/, "ws")}/sessions/${sessionId}/ws?type=sandbox`;
    for (let attempt = 1; attempt <= BRIDGE_CONNECT_ATTEMPTS; attempt++) {
      if (closing) return;
      const connected = await new Promise((resolve) => {
        const socket = new WebSocket(wsUrl, {
          headers: { Authorization: `Bearer ${authToken}`, "X-Sandbox-ID": sandboxId },
        });
        const bridge = { socket, heartbeat: null };
        bridges.set(sandboxId, bridge);

        const send = (event) =>
          socket.readyState === WebSocket.OPEN &&
          socket.send(JSON.stringify({ sandboxId, timestamp: Date.now() / 1000, ...event }));

        socket.on("open", () => {
          state.bridgeConnections += 1;
          bridge.heartbeat = setInterval(() => send({ type: "heartbeat" }), heartbeatMs);
          log("bridge.connected", { session_id: sessionId, sandbox_id: sandboxId, attempt });
          send({
            type: "ready",
            agentSessionId: null,
            harness: "opencode",
            runtimeVersion,
            preservationProtocolVersion: 1,
          });
          resolve(true);
        });

        socket.on("message", (raw) => {
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
            state.promptsReceived.push({ messageId: command.messageId, content: command.content });
            log("bridge.prompt", { session_id: sessionId, message_id: command.messageId });
            clearTurn(socket);
            const split = Math.max(1, Math.floor(BRIDGE_REPLY.length / 2));
            send({
              type: "token",
              messageId: command.messageId,
              content: BRIDGE_REPLY.slice(0, split),
            });
            const finish = () => {
              clearTurn(socket);
              send({ type: "token", messageId: command.messageId, content: BRIDGE_REPLY });
              send({ type: "execution_complete", messageId: command.messageId, success: true });
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

  const tasks = new Set();
  function connect(options) {
    const task = runBridge(options).finally(() => tasks.delete(task));
    tasks.add(task);
  }

  async function handleCreateSandbox(body) {
    const sandboxId = body.sandbox_id ?? `smoke-sandbox-${Date.now()}`;
    state.createRequests.push({ sessionId: body.session_id, sandboxId });
    log("create_sandbox", {
      session_id: body.session_id,
      sandbox_id: sandboxId,
      control_plane_url: body.control_plane_url,
    });

    // Dial back only after the response is on the wire, the way a real sandbox
    // boots after Modal has answered.
    later(() => {
      connect({
        sessionId: body.session_id,
        sandboxId,
        controlPlaneUrl: body.control_plane_url,
        authToken: body.sandbox_auth_token,
      });
    }, 0);

    return {
      success: true,
      data: { sandbox_id: sandboxId, modal_object_id: `mo-${sandboxId}`, created_at: Date.now() },
    };
  }

  const ROUTES = {
    "/api-create-sandbox": handleCreateSandbox,
    "/api-snapshot-sandbox": () => {
      state.snapshots += 1;
      return { success: true, data: { image_id: `smoke-image-${state.snapshots}` } };
    },
    "/api-restore-sandbox": (body) => {
      state.restores += 1;
      const sandboxId = body.sandbox_id ?? `smoke-sandbox-${Date.now()}`;
      // Restore carries the session inside `session_config`, unlike create,
      // which carries it at the root. Reading the wrong one dials
      // `/sessions/undefined/ws`, so fail loudly instead.
      const sessionId = body.session_config?.session_id;
      if (!sessionId) throw new Error("restore request carried no session_config.session_id");
      later(() => {
        connect({
          sessionId,
          sandboxId,
          controlPlaneUrl: body.control_plane_url,
          authToken: body.sandbox_auth_token,
        });
      }, 0);
      return { success: true, data: { sandbox_id: sandboxId, modal_object_id: `mo-${sandboxId}` } };
    },
    "/api-stop-sandbox": (body) => {
      const sandboxId = body.sandbox_id?.replace(/^mo-/, "");
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
    const path = new URL(req.url, "http://localhost").pathname;

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
        log("request.failed", { path, error: error.message });
        sendJson(res, 500, { success: false, error: error.message });
      });
  });

  server.listen(port, host);
  await once(server, "listening");
  const address = server.address();
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
