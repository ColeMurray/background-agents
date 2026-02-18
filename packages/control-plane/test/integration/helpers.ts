import { SELF, env, runInDurableObject } from "cloudflare:test";
import type { SessionDO } from "../../src/session/durable-object";

/**
 * Create a fresh DO, call /internal/init, return the stub and id.
 */
export async function initSession(overrides?: {
  sessionName?: string;
  repoOwner?: string;
  repoName?: string;
  repoId?: number;
  title?: string;
  model?: string;
  reasoningEffort?: string;
  userId?: string;
  githubLogin?: string;
}) {
  const id = env.SESSION.newUniqueId();
  const stub = env.SESSION.get(id);
  const defaults = {
    sessionName: `test-${Date.now()}`,
    repoOwner: "acme",
    repoName: "web-app",
    repoId: 12345,
    userId: "user-1",
    ...overrides,
  };
  const res = await stub.fetch("http://internal/internal/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(defaults),
  });
  if (res.status !== 200) throw new Error(`Init failed: ${res.status}`);
  return { stub, id };
}

/**
 * Query the DO's SQLite via runInDurableObject.
 */
export async function queryDO<T>(
  stub: DurableObjectStub,
  sql: string,
  ...params: unknown[]
): Promise<T[]> {
  return runInDurableObject(stub, (instance: SessionDO) => {
    return instance.ctx.storage.sql.exec(sql, ...params).toArray() as T[];
  });
}

/**
 * Seed events directly into DO SQLite.
 */
export async function seedEvents(
  stub: DurableObjectStub,
  events: Array<{
    id: string;
    type: string;
    data: string;
    messageId?: string;
    createdAt: number;
  }>
): Promise<void> {
  await runInDurableObject(stub, (instance: SessionDO) => {
    for (const e of events) {
      instance.ctx.storage.sql.exec(
        "INSERT INTO events (id, type, data, message_id, created_at) VALUES (?, ?, ?, ?, ?)",
        e.id,
        e.type,
        e.data,
        e.messageId ?? null,
        e.createdAt
      );
    }
  });
}

/**
 * Seed a message directly into DO SQLite.
 */
export async function seedMessage(
  stub: DurableObjectStub,
  msg: {
    id: string;
    authorId: string;
    content: string;
    source: string;
    status: string;
    createdAt: number;
    startedAt?: number;
  }
): Promise<void> {
  await runInDurableObject(stub, (instance: SessionDO) => {
    instance.ctx.storage.sql.exec(
      "INSERT INTO messages (id, author_id, content, source, status, created_at, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      msg.id,
      msg.authorId,
      msg.content,
      msg.source,
      msg.status,
      msg.createdAt,
      msg.startedAt ?? null
    );
  });
}

// ---------------------------------------------------------------------------
// WebSocket test helpers
// ---------------------------------------------------------------------------

/**
 * Create a session using idFromName() so the worker's /sessions/:name/ws
 * route can locate the DO via the same name. Returns stub + sessionName.
 */
export async function initNamedSession(
  sessionName: string,
  overrides?: {
    repoOwner?: string;
    repoName?: string;
    repoId?: number;
    title?: string;
    model?: string;
    userId?: string;
    githubLogin?: string;
  }
) {
  const id = env.SESSION.idFromName(sessionName);
  const stub = env.SESSION.get(id);
  const defaults = {
    sessionName,
    repoOwner: "acme",
    repoName: "web-app",
    repoId: 12345,
    userId: "user-1",
    ...overrides,
  };
  const res = await stub.fetch("http://internal/internal/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(defaults),
  });
  if (res.status !== 200) throw new Error(`Init failed: ${res.status}`);
  return { stub, id, sessionName };
}

/**
 * Collect JSON messages from a WebSocket until a predicate matches or timeout.
 * Starts listening immediately — call BEFORE sending the message that triggers responses.
 */
export function collectMessages(
  ws: WebSocket,
  opts?: { until?: (msg: Record<string, unknown>) => boolean; timeoutMs?: number }
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    const messages: Record<string, unknown>[] = [];
    const timeout = opts?.timeoutMs ?? 2000;
    const timer = setTimeout(() => resolve(messages), timeout);

    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(typeof event.data === "string" ? event.data : "{}");
      messages.push(msg);
      if (opts?.until?.(msg)) {
        clearTimeout(timer);
        resolve(messages);
      }
    });
  });
}

/**
 * Open a client WebSocket via SELF.fetch (full worker routing path).
 * Optionally subscribe by generating a WS token and completing the subscribe flow.
 */
export async function openClientWs(
  sessionName: string,
  opts?: { subscribe?: boolean; userId?: string }
) {
  const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/ws`, {
    headers: { Upgrade: "websocket" },
  });

  const ws = response.webSocket;
  if (!ws) throw new Error("No webSocket on response");
  ws.accept();

  if (!opts?.subscribe) {
    return { ws };
  }

  // Generate a WS token via the DO
  const id = env.SESSION.idFromName(sessionName);
  const stub = env.SESSION.get(id);
  const tokenRes = await stub.fetch("http://internal/internal/ws-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: opts.userId ?? "user-1" }),
  });
  const { token, participantId } = await tokenRes.json<{
    token: string;
    participantId: string;
  }>();

  // Start collecting BEFORE sending subscribe to avoid race.
  // The subscribed message now includes batched replay data, so we terminate on it
  // (presence_sync follows but is not needed for most tests).
  const collector = collectMessages(ws, {
    until: (msg) => msg.type === "subscribed",
  });

  ws.send(
    JSON.stringify({
      type: "subscribe",
      token,
      clientId: `test-client-${Date.now()}`,
    })
  );

  const messages = await collector;
  return { ws, token, participantId, messages };
}

/**
 * Open a sandbox WebSocket via SELF.fetch (full worker routing path).
 * Returns the WebSocket (or null if upgrade failed) and the raw response.
 */
export async function openSandboxWs(
  sessionName: string,
  opts: { authToken: string; sandboxId: string }
) {
  const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/ws?type=sandbox`, {
    headers: {
      Upgrade: "websocket",
      Authorization: `Bearer ${opts.authToken}`,
      "X-Sandbox-ID": opts.sandboxId,
    },
  });
  return { ws: response.webSocket ?? null, response };
}

/**
 * Seed auth_token and modal_sandbox_id on the sandbox row so sandbox
 * WebSocket auth can pass.
 */
export async function seedSandboxAuth(
  stub: DurableObjectStub,
  opts: { authToken: string; sandboxId: string }
): Promise<void> {
  await runInDurableObject(stub, (instance: SessionDO) => {
    instance.ctx.storage.sql.exec(
      "UPDATE sandbox SET auth_token = ?, modal_sandbox_id = ?",
      opts.authToken,
      opts.sandboxId
    );
  });
}
