import { SELF, env, runInDurableObject } from "cloudflare:test";
import { buildServiceAuthHeaders, type ServiceName } from "@open-inspect/shared";
import type { SandboxStatus } from "../../src/types";
import type { SessionDO } from "../../src/session/durable-object";
import { hashToken } from "../../src/auth/crypto";

const DEFAULT_WAIT_FOR_SANDBOX_STATUS_TIMEOUT_MS = 3000;
const TEST_BROWSER_USER_ID = "11111111111111111111111111111111";
const TEST_BROWSER_ACCOUNT_ID = "test-browser-account";
const TEST_BROWSER_PROVIDER_SUBJECT = "583231";
const TEST_BROWSER_SESSION_ID = "test-browser-session";
const TEST_BROWSER_SESSION_TOKEN = "test-browser-session-token";
const TEST_BROWSER_SESSION_COOKIE = "__Secure-openinspect.session_token";

async function signCookieValue(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))
  );
  const signatureBase64 = btoa(String.fromCharCode(...signature));
  return encodeURIComponent(`${value}.${signatureBase64}`);
}

/**
 * Seed one real Better Auth user/account/session and return its signed cookie.
 *
 * Integration route tests exercise browser-owned endpoints, so their default
 * web request must carry the same compound credential as production. Direct
 * service-auth tests intentionally build their own bare sig1 requests.
 */
async function testBrowserSessionCookie(): Promise<string> {
  const secret = env.BROWSER_AUTH_SECRET;
  if (!secret) throw new Error("BROWSER_AUTH_SECRET is not configured for integration tests");

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const applicationTimestamp = now.getTime();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO auth_users
         (id, name, email, emailVerified, image, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      TEST_BROWSER_USER_ID,
      "Integration Browser User",
      "browser@test.local",
      1,
      null,
      now.toISOString(),
      now.toISOString()
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO users
         (id, display_name, email, avatar_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      TEST_BROWSER_USER_ID,
      "Integration Browser User",
      "browser@test.local",
      null,
      applicationTimestamp,
      applicationTimestamp
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO auth_accounts
         (id, accountId, providerId, userId, accessToken, refreshToken, idToken,
          accessTokenExpiresAt, refreshTokenExpiresAt, scope, password, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      TEST_BROWSER_ACCOUNT_ID,
      TEST_BROWSER_PROVIDER_SUBJECT,
      "github",
      TEST_BROWSER_USER_ID,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      now.toISOString(),
      now.toISOString()
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO auth_sessions
         (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      TEST_BROWSER_SESSION_ID,
      expiresAt.toISOString(),
      TEST_BROWSER_SESSION_TOKEN,
      now.toISOString(),
      now.toISOString(),
      "127.0.0.1",
      "integration-test",
      TEST_BROWSER_USER_ID
    ),
  ]);

  const signedToken = await signCookieValue(TEST_BROWSER_SESSION_TOKEN, secret);
  return `${TEST_BROWSER_SESSION_COOKIE}=${signedToken}`;
}

/**
 * Fetch a control-plane route with production-equivalent credentials. Web
 * calls carry both sig1 and a Better Auth browser session; other services
 * carry their service credential. Signs per request because sig1 binds method,
 * URL, and body.
 */
export async function serviceFetch(
  url: string,
  init?: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    service?: ServiceName;
    actor?: string;
  }
): Promise<Response> {
  const method = init?.method ?? "GET";
  const service = init?.service ?? "web";
  const auth = await buildServiceAuthHeaders({
    service,
    secret: `test-service-secret-${service}`,
    method,
    url,
    body: init?.body,
    actor: init?.actor,
  });
  const browserCookie = service === "web" ? await testBrowserSessionCookie() : undefined;
  return SELF.fetch(url, {
    method,
    headers: {
      ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(browserCookie ? { Cookie: browserCookie } : {}),
      ...init?.headers,
      ...auth,
    },
    body: init?.body,
  });
}

/**
 * Create a fresh DO, call /internal/init, return the stub and id.
 */
export async function initSession(overrides?: {
  sessionName?: string;
  repoOwner?: string;
  repoName?: string;
  repoId?: number;
  defaultBranch?: string;
  repositories?: Array<{
    repoOwner: string;
    repoName: string;
    repoId: number;
    baseBranch: string;
  }>;
  environmentId?: string | null;
  title?: string;
  model?: string;
  reasoningEffort?: string;
  userId?: string;
  scmLogin?: string;
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

export async function waitForSandboxStatus(
  stub: DurableObjectStub,
  status: string,
  timeoutMs = DEFAULT_WAIT_FOR_SANDBOX_STATUS_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: string | undefined;
  while (Date.now() < deadline) {
    const rows = await queryDO<{ status: string }>(stub, "SELECT status FROM sandbox");
    lastStatus = rows[0]?.status;
    if (lastStatus === status) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for sandbox status "${status}"; last status was "${lastStatus ?? "missing"}"`
  );
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
    defaultBranch?: string;
    repositories?: Array<{
      repoOwner: string;
      repoName: string;
      repoId: number;
      baseBranch: string;
    }>;
    title?: string;
    model?: string;
    reasoningEffort?: string;
    userId?: string;
    scmLogin?: string;
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
 * Seed a sandbox with auth_token and modal_sandbox_id so sandbox auth can
 * pass, in the given lifecycle status (default: the "ready" steady state).
 * Waits out the (always-failing) test spawn first so its status write can't
 * clobber the seeded status.
 */
export async function seedSandboxAuth(
  stub: DurableObjectStub,
  opts: { authToken: string; sandboxId: string; status?: SandboxStatus }
): Promise<void> {
  await waitForSandboxStatus(stub, "failed");
  const tokenHash = await hashToken(opts.authToken);

  await runInDurableObject(stub, (instance: SessionDO) => {
    instance.ctx.storage.sql.exec(
      "UPDATE sandbox SET auth_token = ?, auth_token_hash = ?, modal_sandbox_id = ?, status = ?",
      opts.authToken,
      tokenHash,
      opts.sandboxId,
      opts.status ?? "ready"
    );
  });
}

/**
 * Seed a sandbox with auth_token_hash and modal_sandbox_id, in the given
 * lifecycle status (default: the "ready" steady state). Waits out the
 * (always-failing) test spawn first so its status write can't clobber the
 * seeded status.
 */
export async function seedSandboxAuthHash(
  stub: DurableObjectStub,
  opts: { authToken: string; sandboxId: string; status?: SandboxStatus }
): Promise<void> {
  await waitForSandboxStatus(stub, "failed");
  const tokenHash = await hashToken(opts.authToken);

  await runInDurableObject(stub, (instance: SessionDO) => {
    instance.ctx.storage.sql.exec(
      "UPDATE sandbox SET auth_token_hash = ?, auth_token = NULL, modal_sandbox_id = ?, status = ?",
      tokenHash,
      opts.sandboxId,
      opts.status ?? "ready"
    );
  });
}
