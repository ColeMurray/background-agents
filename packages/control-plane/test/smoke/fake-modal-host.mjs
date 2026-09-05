/**
 * A stand-in for the Modal data plane, for the compose smoke test.
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
import { createServer } from "node:http";
import { WebSocket } from "ws";

const PORT = Number(process.env.PORT ?? 9900);
const SECRET = process.env.MODAL_API_SECRET ?? "";
const BRIDGE_REPLY = process.env.BRIDGE_REPLY ?? "Acknowledged by the smoke bridge.";

/** How long a `timestamp.signature` internal token stays acceptable. */
const TOKEN_VALIDITY_MS = 5 * 60 * 1000;
/** The control plane persists the sandbox identity before it calls create, but retry anyway. */
const BRIDGE_CONNECT_ATTEMPTS = 10;
const BRIDGE_CONNECT_RETRY_MS = 300;

/** What the driver reads back from `/__smoke/state` to assert on. */
const state = {
  createRequests: [],
  bridgeConnections: 0,
  promptsReceived: [],
  snapshots: 0,
  rejectedTokens: 0,
};

function log(event, fields = {}) {
  console.log(JSON.stringify({ component: "fake-modal-host", event, ...fields }));
}

/**
 * Verify the control plane's `timestamp.signature` internal token, the
 * MODAL_API_SECRET mechanism `generateInternalToken` produces. Modal itself
 * performs this check, so the smoke proves the secret is wired on both sides.
 */
function isValidInternalToken(header) {
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!token) return false;
  const [timestamp, signature] = token.split(".");
  if (!timestamp || !signature) return false;
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
    const connected = await new Promise((resolve) => {
      const socket = new WebSocket(wsUrl, {
        headers: { Authorization: `Bearer ${authToken}`, "X-Sandbox-ID": sandboxId },
      });

      const send = (event) =>
        socket.send(JSON.stringify({ sandboxId, timestamp: Date.now(), ...event }));

      socket.on("open", () => {
        state.bridgeConnections += 1;
        log("bridge.connected", { session_id: sessionId, sandbox_id: sandboxId, attempt });
        send({ type: "ready", opencodeSessionId: null, runtimeVersion: "smoke" });
        resolve(true);
      });

      socket.on("message", (raw) => {
        let command;
        try {
          command = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (command.type === "prompt") {
          state.promptsReceived.push({ messageId: command.messageId, content: command.content });
          log("bridge.prompt", { session_id: sessionId, message_id: command.messageId });
          send({ type: "token", messageId: command.messageId, content: BRIDGE_REPLY });
          send({ type: "execution_complete", messageId: command.messageId, success: true });
        } else if (command.type === "shutdown") {
          log("bridge.shutdown", { session_id: sessionId });
          socket.close();
        }
      });

      socket.on("close", (code) => log("bridge.closed", { session_id: sessionId, code }));

      socket.on("error", (error) => {
        log("bridge.error", { session_id: sessionId, attempt, error: error.message });
        resolve(false);
      });
    });

    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, BRIDGE_CONNECT_RETRY_MS));
  }
  log("bridge.gave_up", { session_id: sessionId, sandbox_id: sandboxId });
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
  setImmediate(() => {
    void runBridge({
      sessionId: body.session_id,
      sandboxId,
      controlPlaneUrl: body.control_plane_url,
      authToken: body.sandbox_auth_token,
    });
  });

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
    const sandboxId = body.sandbox_id ?? `smoke-sandbox-${Date.now()}`;
    // Restore carries the session inside `session_config`, unlike create,
    // which carries it at the root. Reading the wrong one dials
    // `/sessions/undefined/ws`, so fail loudly instead.
    const sessionId = body.session_config?.session_id;
    if (!sessionId) throw new Error("restore request carried no session_config.session_id");
    setImmediate(() => {
      void runBridge({
        sessionId,
        sandboxId,
        controlPlaneUrl: body.control_plane_url,
        authToken: body.sandbox_auth_token,
      });
    });
    return { success: true, data: { sandbox_id: sandboxId, modal_object_id: `mo-${sandboxId}` } };
  },
};

const server = createServer((req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;

  if (path === "/__smoke/state") {
    sendJson(res, 200, state);
    return;
  }

  const handler = ROUTES[path];
  if (!handler) {
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

server.listen(PORT, "0.0.0.0", () => log("listening", { port: PORT }));
