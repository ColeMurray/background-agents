import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Env } from "./types";
import type * as WebhookHandler from "./webhook-handler";

const mocks = vi.hoisted(() => ({
  handleAgentSessionEvent: vi.fn(async () => undefined),
}));

vi.mock("./webhook-handler", async (importOriginal) => {
  const actual = await importOriginal<typeof WebhookHandler>();
  return {
    ...actual,
    handleAgentSessionEvent: mocks.handleAgentSessionEvent,
  };
});

const { default: app } = await import("./index");

const SECRET = "test-linear-webhook-secret";

interface PutCall {
  key: string;
  value: string;
  options?: { expirationTtl?: number };
}

async function sign(body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function createFakeKV(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const putCalls: PutCall[] = [];

  const kv = {
    get: vi.fn(async (key: string, type?: string) => {
      const value = store.get(key) ?? null;
      if (value === null) return null;
      if (type === "json") return JSON.parse(value) as unknown;
      return value;
    }),
    put: vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }) => {
      store.set(key, value);
      putCalls.push({ key, value, options });
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };

  return { kv: kv as unknown as KVNamespace, store, putCalls };
}

function makeEnv(kv: KVNamespace): Env {
  return {
    LINEAR_KV: kv,
    LINEAR_WEBHOOK_SECRET: SECRET,
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    DEPLOYMENT_NAME: "test",
    CONTROL_PLANE_URL: "https://control-plane.example.test",
    WEB_APP_URL: "https://web.example.test",
    LINEAR_CLIENT_ID: "linear-client-id",
    LINEAR_CLIENT_SECRET: "linear-client-secret",
    WORKER_URL: "https://linear-bot.example.test",
    ANTHROPIC_API_KEY: "anthropic-key",
    CONTROL_PLANE: { fetch: vi.fn() } as unknown as Fetcher,
  };
}

function makeCtx() {
  return {
    props: {},
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext & { waitUntil: ReturnType<typeof vi.fn> };
}

function makeAgentSessionPayload(webhookId = "webhook-config-1") {
  return {
    type: "AgentSessionEvent",
    action: "created",
    organizationId: "org-1",
    webhookId,
    agentSession: {
      id: "agent-session-1",
      promptContext: "Implement the Linear issue.",
    },
  };
}

async function makeWebhookRequest(payload: unknown, deliveryId?: string): Promise<Request> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "linear-signature": await sign(body),
  };
  if (deliveryId) headers["linear-delivery"] = deliveryId;

  return new Request("http://localhost/webhook", {
    method: "POST",
    headers,
    body,
  });
}

describe("POST /webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects AgentSessionEvent payloads without Linear-Delivery before dedupe or enqueue", async () => {
    const { kv } = createFakeKV();
    const ctx = makeCtx();

    const res = await app.fetch(
      await makeWebhookRequest(makeAgentSessionPayload()),
      makeEnv(kv),
      ctx
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing Linear-Delivery header" });
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(mocks.handleAgentSessionEvent).not.toHaveBeenCalled();
  });

  it("deduplicates AgentSessionEvent deliveries by Linear-Delivery header", async () => {
    const { kv, putCalls } = createFakeKV();
    const env = makeEnv(kv);
    const ctx = makeCtx();
    const payload = makeAgentSessionPayload();

    const firstRes = await app.fetch(await makeWebhookRequest(payload, "delivery-1"), env, ctx);
    const duplicateRes = await app.fetch(await makeWebhookRequest(payload, "delivery-1"), env, ctx);

    expect(firstRes.status).toBe(200);
    expect(await firstRes.json()).toEqual({ ok: true });
    expect(duplicateRes.status).toBe(200);
    expect(await duplicateRes.json()).toEqual({ ok: true, skipped: true, reason: "duplicate" });
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    expect(mocks.handleAgentSessionEvent).toHaveBeenCalledOnce();
    expect(putCalls).toEqual([
      { key: "event:delivery-1", value: "1", options: { expirationTtl: 3600 } },
    ]);
  });

  it("does not treat distinct Linear-Delivery headers with the same webhookId as duplicates", async () => {
    const { kv, putCalls } = createFakeKV();
    const env = makeEnv(kv);
    const ctx = makeCtx();
    const payload = makeAgentSessionPayload("stable-webhook-config-id");

    const firstRes = await app.fetch(await makeWebhookRequest(payload, "delivery-1"), env, ctx);
    const secondRes = await app.fetch(await makeWebhookRequest(payload, "delivery-2"), env, ctx);

    expect(firstRes.status).toBe(200);
    expect(await firstRes.json()).toEqual({ ok: true });
    expect(secondRes.status).toBe(200);
    expect(await secondRes.json()).toEqual({ ok: true });
    expect(ctx.waitUntil).toHaveBeenCalledTimes(2);
    expect(mocks.handleAgentSessionEvent).toHaveBeenCalledTimes(2);
    expect(putCalls.map((call) => call.key)).toEqual(["event:delivery-1", "event:delivery-2"]);
  });

  it("rejects malformed AgentSessionEvent payloads before dedupe", async () => {
    const { kv } = createFakeKV();
    const ctx = makeCtx();
    const payload = {
      type: "AgentSessionEvent",
      action: "created",
      organizationId: "org-1",
      webhookId: "webhook-config-1",
      agentSession: {},
    };

    const res = await app.fetch(await makeWebhookRequest(payload, "delivery-1"), makeEnv(kv), ctx);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid payload" });
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });
});
