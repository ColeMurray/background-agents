#!/usr/bin/env node

declare const process: {
  env: Record<string, string | undefined>;
  exit(code?: number): never;
};

type JsonObject = Record<string, unknown>;

const CONTROL_PLANE_URL = requiredEnv("ISLO_SMOKE_CONTROL_PLANE_URL");
const MODEL = process.env.ISLO_SMOKE_MODEL || "anthropic/claude-sonnet-4-5";
const PROMPT =
  process.env.ISLO_SMOKE_PROMPT ||
  "Reply with exactly: islo smoke ok. Do not run tools and do not add extra text.";
const USER_ID = process.env.ISLO_SMOKE_USER_ID || "islo-smoke";
const CLIENT_ID = process.env.ISLO_SMOKE_CLIENT_ID || `islo-smoke-${Date.now()}`;
const TIMEOUT_MS = Number(process.env.ISLO_SMOKE_TIMEOUT_MS || "600000");
const SEED_GLOBAL_SECRET = process.env.ISLO_SMOKE_SEED_GLOBAL_SECRET === "true";

async function main(): Promise<void> {
  const baseUrl = normalizeBaseUrl(CONTROL_PLANE_URL);
  const deadline = Date.now() + TIMEOUT_MS;

  if (SEED_GLOBAL_SECRET) {
    const anthropicApiKey = requiredEnv("ANTHROPIC_API_KEY");
    await api(baseUrl, "/secrets", {
      method: "PUT",
      body: { secrets: { ANTHROPIC_API_KEY: anthropicApiKey } },
    });
    log("seeded global ANTHROPIC_API_KEY");
  } else {
    log("assuming model key is already configured as a global secret");
  }

  const session = await api<{ sessionId: string }>(baseUrl, "/sessions", {
    method: "POST",
    body: {
      title: `Islo live smoke ${new Date().toISOString()}`,
      repoOwner: null,
      repoName: null,
      model: MODEL,
      userId: USER_ID,
      authProvider: "github",
      authUserId: USER_ID,
      authName: "Islo Smoke",
      spawnSource: "user",
    },
  });
  log(`created session ${session.sessionId}`);

  const wsToken = await api<{ token: string; participantId: string }>(
    baseUrl,
    `/sessions/${encodeURIComponent(session.sessionId)}/ws-token`,
    {
      method: "POST",
      body: { userId: USER_ID },
    }
  );
  log(`created websocket token for participant ${wsToken.participantId}`);

  const observed = {
    sandboxRunning: false,
    bridgeReady: false,
    promptQueued: false,
    promptOutput: false,
    executionComplete: false,
  };

  const socket = new WebSocket(`${toWsBase(baseUrl)}/sessions/${session.sessionId}/ws`);
  const completion = new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => {
      if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for smoke completion: ${JSON.stringify(observed)}`));
      }
    }, 1000);

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          type: "subscribe",
          token: wsToken.token,
          clientId: CLIENT_ID,
        })
      );
    });

    socket.addEventListener("message", (event) => {
      let message: JsonObject;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (message.type === "subscribed") {
        log("websocket subscribed");
      } else if (message.type === "sandbox_status") {
        const status = String(message.status || "");
        log(`sandbox status: ${status}`);
        if (status === "connecting" || status === "ready") observed.sandboxRunning = true;
      } else if (message.type === "sandbox_ready") {
        observed.sandboxRunning = true;
      } else if (message.type === "prompt_queued") {
        observed.promptQueued = true;
        log(`prompt queued: ${String(message.messageId || "")}`);
      } else if (message.type === "sandbox_event" && isObject(message.event)) {
        const eventPayload = message.event as JsonObject;
        const eventType = String(eventPayload.type || "");
        if (eventType === "ready") {
          observed.bridgeReady = true;
          log("sandbox bridge ready");
        } else if (eventType === "token") {
          observed.promptOutput = true;
        } else if (eventType === "execution_complete") {
          observed.executionComplete = eventPayload.success === true;
          clearInterval(timer);
          if (observed.executionComplete && Object.values(observed).every(Boolean)) {
            resolve();
          } else {
            reject(
              new Error(
                `Execution completed but smoke assertions failed: ${JSON.stringify(observed)}`
              )
            );
          }
        } else if (eventType === "error") {
          log(`sandbox event error: ${String(eventPayload.error || "")}`);
        }
      } else if (message.type === "sandbox_error") {
        clearInterval(timer);
        reject(new Error(`Sandbox error: ${String(message.error || "")}`));
      }
    });

    socket.addEventListener("error", () => {
      clearInterval(timer);
      reject(new Error("WebSocket error"));
    });
  });

  await waitForSocketOpen(socket, deadline);
  await api(baseUrl, `/sessions/${encodeURIComponent(session.sessionId)}/prompt`, {
    method: "POST",
    body: {
      content: PROMPT,
      authorId: USER_ID,
      source: "islo-live-smoke",
      model: MODEL,
    },
  });
  log("prompt sent");

  await completion.finally(() => socket.close());
  log("Islo live smoke passed");
}

async function api<T = JsonObject>(
  baseUrl: string,
  path: string,
  options: { method: string; body?: JsonObject }
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers: { "Content-Type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${options.method} ${path} failed (${response.status}): ${text}`);
  }
  return payload as T;
}

function waitForSocketOpen(socket: WebSocket, deadline: number): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error("Timed out waiting for WebSocket open"));
      }
    }, 100);
  });
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function toWsBase(baseUrl: string): string {
  return baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function log(message: string): void {
  console.log(`[islo-live-smoke] ${message}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
