import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import type * as WebhookHandler from "./webhook-handler";
import {
  createFakeKV,
  createLinearFetchMock,
  linearAuthorizationCodeResponse,
  linearClientCredentialsResponse,
  linearIdentityResponse,
  makeExecutionContext,
  makeLinearBotEnv,
  signLinearWebhookRequest,
} from "./test-helpers";

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

function makeAgentSessionPayload(webhookId = "webhook-config-1") {
  return {
    type: "AgentSessionEvent",
    action: "created",
    organizationId: "org-1",
    appUserId: "app-user-1",
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
    "linear-signature": await signLinearWebhookRequest(body),
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
    const ctx = makeExecutionContext();

    const res = await app.fetch(
      await makeWebhookRequest(makeAgentSessionPayload()),
      makeLinearBotEnv(kv),
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
    const env = makeLinearBotEnv(kv);
    const ctx = makeExecutionContext();
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
    const env = makeLinearBotEnv(kv);
    const ctx = makeExecutionContext();
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
    const ctx = makeExecutionContext();
    const payload = {
      type: "AgentSessionEvent",
      action: "created",
      organizationId: "org-1",
      webhookId: "webhook-config-1",
      agentSession: {},
    };

    const res = await app.fetch(
      await makeWebhookRequest(payload, "delivery-1"),
      makeLinearBotEnv(kv),
      ctx
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid payload" });
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(mocks.handleAgentSessionEvent).not.toHaveBeenCalled();
  });
});

describe("GET /oauth/callback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("establishes verified client credentials without storing authorization-code tokens", async () => {
    const { kv, store } = createFakeKV({
      "oauth:token:org-1": JSON.stringify({ refresh_token: "legacy-refresh-token" }),
    });
    const env = makeLinearBotEnv(kv);
    const fetchMock = createLinearFetchMock({
      authorizationCode: () =>
        Response.json({
          access_token: "installation-access-token",
          token_type: "Bearer",
        }),
      clientCredentials: () => linearClientCredentialsResponse(),
      identity: () => linearIdentityResponse(),
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.fetch(
      new Request("http://localhost/oauth/callback?code=authorization-code"),
      env,
      makeExecutionContext()
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(
      "Successfully connected to workspace: <strong>Acme</strong>"
    );
    const cached = store.get("oauth:client-credentials:org-1") ?? "";
    expect(cached).toContain("runtime-access-token");
    expect(cached).not.toContain("installation-access-token");
    expect(cached).not.toContain("installation-refresh-token");
    expect(store.has("oauth:token:org-1")).toBe(false);
  });

  it("does not claim readiness when client credentials are disabled", async () => {
    const { kv, store } = createFakeKV({
      "oauth:token:org-1": "legacy-token-record",
    });
    vi.stubGlobal(
      "fetch",
      createLinearFetchMock({
        authorizationCode: () => linearAuthorizationCodeResponse(),
        identity: () => linearIdentityResponse(),
        clientCredentials: () =>
          Response.json(
            {
              error: "Error",
              error_description: "Client does not support the client_credentials grant type",
            },
            { status: 400 }
          ),
      })
    );

    const response = await app.fetch(
      new Request("http://localhost/oauth/callback?code=authorization-code"),
      makeLinearBotEnv(kv),
      makeExecutionContext()
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Linear authentication setup failed");
    expect(store.get("oauth:token:org-1")).toBe("legacy-token-record");
    expect(store.has("oauth:client-credentials:org-1")).toBe(false);
  });

  it("does not claim readiness when the runtime credential cannot be cached", async () => {
    const { kv, store } = createFakeKV({
      "oauth:token:org-1": "legacy-token-record",
    });
    vi.mocked(kv.put).mockRejectedValueOnce(new Error("KV unavailable"));
    vi.stubGlobal(
      "fetch",
      createLinearFetchMock({
        authorizationCode: () => linearAuthorizationCodeResponse(),
        clientCredentials: () => linearClientCredentialsResponse(),
        identity: () => linearIdentityResponse(),
      })
    );

    const response = await app.fetch(
      new Request("http://localhost/oauth/callback?code=authorization-code"),
      makeLinearBotEnv(kv),
      makeExecutionContext()
    );

    expect(response.status).toBe(500);
    expect(store.get("oauth:token:org-1")).toBe("legacy-token-record");
  });
});
