/**
 * The compose smoke's session round-trip.
 *
 * Runs against a booted stack (see `scripts/compose-smoke.sh`) and drives one
 * session the way a caller does: create it, mint a WebSocket token, subscribe a
 * client socket, send a prompt, and wait for the stand-in sandbox's reply to
 * arrive back on that socket. Every call is a signed HTTP request against the
 * published API, so this exercises the container's real routing, admission,
 * persistence, and both WebSocket roles without reaching into its database.
 *
 * Reads CONTROL_PLANE_URL, FAKE_MODAL_URL, SERVICE_AUTH_SECRET_SLACK_BOT.
 */

import { buildServiceAuthHeaders } from "@open-inspect/shared/service-auth";
import { WebSocket } from "ws";

const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL ?? "http://localhost:8787";
const FAKE_MODAL_URL = process.env.FAKE_MODAL_URL ?? "http://localhost:9900";
const SERVICE = "slack-bot";
const SERVICE_SECRET = process.env.SERVICE_AUTH_SECRET_SLACK_BOT ?? "";
/** The bridge's canned answer; the stand-in host sends exactly this. */
const BRIDGE_REPLY = process.env.BRIDGE_REPLY ?? "Acknowledged by the smoke bridge.";

/**
 * The smoke's caller: a verified Slack service asserting one actor. Admission
 * enrolls the actor as a canonical user on first sight, so the run needs no
 * seeded rows and touches no private schema.
 */
const ACTOR = "slack:U-COMPOSE-SMOKE";
const ACTOR_EMAIL = "compose-smoke@open-inspect.test";

/** Budgets for the two waits that depend on the container doing real work. */
const PROMPT_ROUND_TRIP_TIMEOUT_MS = 60_000;
const SUBSCRIBE_TIMEOUT_MS = 15_000;

function fail(message, detail) {
  console.error(`\nFAIL: ${message}`);
  if (detail !== undefined) console.error(detail);
  process.exit(1);
}

function pass(message) {
  console.log(`  ok  ${message}`);
}

async function signedFetch(path, { method = "GET", body } = {}) {
  const url = `${CONTROL_PLANE_URL}${path}`;
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  const headers = await buildServiceAuthHeaders({
    service: SERVICE,
    secret: SERVICE_SECRET,
    method,
    url,
    body: serialized,
    actor: ACTOR,
  });
  const response = await fetch(url, {
    method,
    headers: {
      ...headers,
      ...(serialized === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: serialized,
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

async function health() {
  const response = await fetch(`${CONTROL_PLANE_URL}/healthz`);
  if (!response.ok) fail(`/healthz returned ${response.status}`);
  const body = await response.json();
  if (body.status !== "ok") fail("/healthz did not report ok", body);
  if (!(body.migrations_applied > 0)) fail("no migrations applied", body);
  if (body.cron !== "running") fail("cron loop is not running", body);
  if (body.alarm_clock !== "running") fail("alarm clock is not running", body);
  pass(`healthz: ${body.migrations_applied} migrations, cron and alarm clock running`);
}

async function createSession() {
  // No repository target: the session needs no SCM call, which keeps the smoke
  // off the network. Repository resolution has its own coverage.
  const { status, body } = await signedFetch("/sessions", {
    method: "POST",
    body: { name: "compose smoke", actorEmail: ACTOR_EMAIL, actorDisplayName: "Compose Smoke" },
  });
  if (status !== 201) fail(`session create returned ${status}`, body);
  if (!body?.sessionId) fail("session create returned no sessionId", body);
  pass(`session created: ${body.sessionId}`);
  return body.sessionId;
}

async function mintWsToken(sessionId) {
  const { status, body } = await signedFetch(`/sessions/${sessionId}/ws-token`, {
    method: "POST",
    body: {},
  });
  if (status !== 200) fail(`ws-token returned ${status}`, body);
  if (!body?.token) fail("ws-token returned no token", body);
  pass("websocket token minted");
  return body.token;
}

/**
 * Subscribe a client socket and resolve once the server acknowledges it, so the
 * prompt is only sent when the socket is guaranteed to receive the replay.
 */
function subscribeClient(sessionId, token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `${CONTROL_PLANE_URL.replace(/^http/, "ws")}/sessions/${sessionId}/ws`
    );
    const received = [];
    const timer = setTimeout(
      () => reject(new Error("client socket was never acknowledged")),
      SUBSCRIBE_TIMEOUT_MS
    );

    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "subscribe", token, clientId: "compose-smoke" }));
    });
    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      received.push(message);
      if (message.type === "subscribed") {
        clearTimeout(timer);
        resolve({ socket, received });
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`client socket closed with ${code}`));
    });
  });
}

/** Resolve when a message satisfying `predicate` arrives on the client socket. */
function waitForMessage(socket, received, predicate, description) {
  const existing = received.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${description}`)),
      PROMPT_ROUND_TRIP_TIMEOUT_MS
    );
    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      received.push(message);
      if (predicate(message)) {
        clearTimeout(timer);
        resolve(message);
      }
    });
  });
}

async function fakeModalState() {
  const response = await fetch(`${FAKE_MODAL_URL}/__smoke/state`);
  if (!response.ok) fail(`stand-in Modal host returned ${response.status}`);
  return response.json();
}

async function main() {
  if (!SERVICE_SECRET) fail("SERVICE_AUTH_SECRET_SLACK_BOT is not set");

  console.log("compose smoke: session round-trip");
  await health();

  const sessionId = await createSession();
  const token = await mintWsToken(sessionId);
  const { socket, received } = await subscribeClient(sessionId, token);
  pass("client socket subscribed");

  const prompt = await signedFetch(`/sessions/${sessionId}/prompt`, {
    method: "POST",
    body: { content: "Say hello from the compose smoke." },
  });
  if (prompt.status !== 200 && prompt.status !== 202) {
    fail(`prompt returned ${prompt.status}`, prompt.body);
  }
  pass(`prompt accepted: message ${prompt.body?.messageId ?? "(unnamed)"}`);

  // The reply travels sandbox -> control plane -> client socket, so seeing it
  // here proves the spawn, the sandbox socket, dispatch, and the client fan-out.
  await waitForMessage(
    socket,
    received,
    (message) =>
      message.type === "sandbox_event" &&
      message.event?.type === "token" &&
      message.event.content === BRIDGE_REPLY,
    "the sandbox's token event on the client socket"
  );
  pass("sandbox reply reached the client socket as a token event");

  await waitForMessage(
    socket,
    received,
    (message) =>
      message.type === "sandbox_event" &&
      message.event?.type === "execution_complete" &&
      message.event.success === true,
    "the turn to complete"
  );
  pass("turn completed");
  socket.close();

  const state = await fakeModalState();
  if (state.createRequests.length < 1) fail("no sandbox was requested", state);
  if (state.bridgeConnections < 1) fail("the bridge never connected", state);
  if (state.promptsReceived.length < 1) fail("the bridge received no prompt", state);
  if (state.rejectedTokens > 0) fail("the stand-in rejected a control-plane token", state);
  pass(
    `stand-in Modal host: ${state.createRequests.length} create, ` +
      `${state.bridgeConnections} bridge connect, ${state.promptsReceived.length} prompt, ` +
      "0 rejected tokens"
  );

  console.log("\ncompose smoke: session round-trip passed");
  process.exit(0);
}

main().catch((error) => fail(error.message, error.stack));
