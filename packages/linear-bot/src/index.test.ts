import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as WebhookHandler from "./webhook-handler";
import {
  consumeOAuthState,
  getLinearAuthState,
  setLinearAuthState,
  storeOAuthState,
} from "./kv-store";
import {
  createFakeKV,
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

describe("OAuth routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("includes a signed OAuth state in the authorize redirect", async () => {
    const { kv, store } = createFakeKV();
    const env = makeLinearBotEnv(kv);

    const res = await app.fetch(new Request("http://localhost/oauth/authorize"), env);

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    const url = new URL(location ?? "");
    const state = url.searchParams.get("state");
    expect(url.origin + url.pathname).toBe("https://linear.app/oauth/authorize");
    expect(url.searchParams.get("actor")).toBe("app");
    expect(state).toBeTruthy();
    await expect(consumeOAuthState(env, state ?? "")).resolves.toBe(true);
    expect([...store.keys()].some((key) => key.startsWith("oauth:state:"))).toBe(false);
  });

  it("rejects OAuth callbacks without a stored state", async () => {
    const { kv } = createFakeKV();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.fetch(
      new Request("http://localhost/oauth/callback?code=code-1&state=missing"),
      makeLinearBotEnv(kv)
    );

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid OAuth state");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stores token and connected auth health after a valid OAuth callback", async () => {
    const { kv, store } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    const state = await storeOAuthState(env, "state-1");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: "access-token",
              token_type: "Bearer",
              expires_in: 3600,
              refresh_token: "refresh-token",
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              data: {
                viewer: {
                  id: "app-user-1",
                  name: "Open-Inspect",
                  organization: { id: "org-1", name: "Acme" },
                },
              },
            }),
        })
    );

    const res = await app.fetch(
      new Request(`http://localhost/oauth/callback?code=code-1&state=${encodeURIComponent(state)}`),
      env
    );

    expect(res.status).toBe(200);
    expect([...store.keys()].some((key) => key.startsWith("oauth:state:"))).toBe(false);
    expect(JSON.parse(store.get("oauth:token:org-1") ?? "{}")).toMatchObject({
      access_token: "access-token",
      refresh_token: "refresh-token",
    });
    await expect(getLinearAuthState(env, "org-1")).resolves.toMatchObject({
      status: "connected",
      reason: "oauth_callback",
      installation: {
        orgName: "Acme",
        appUserId: "app-user-1",
        appUserName: "Open-Inspect",
      },
    });
  });
});

describe("POST /webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("does not reject AgentSessionEvent payloads with stale webhookTimestamp", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    const ctx = makeExecutionContext();
    const payload = {
      ...makeAgentSessionPayload(),
      webhookTimestamp: Date.now() - 5 * 60 * 1000,
    };

    const res = await app.fetch(await makeWebhookRequest(payload, "delivery-1"), env, ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    expect(mocks.handleAgentSessionEvent).toHaveBeenCalledOnce();
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

  it("records OAuth app revocation as reauthorization-required auth health", async () => {
    const { kv, store } = createFakeKV({
      "oauth:token:org-1": JSON.stringify({
        access_token: "fresh-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() + 60 * 60 * 1000,
      }),
    });
    const env = makeLinearBotEnv(kv);
    const payload = {
      type: "OAuthApp",
      action: "revoked",
      organizationId: "org-1",
      webhookTimestamp: Date.now(),
    };

    const res = await app.fetch(await makeWebhookRequest(payload, "delivery-auth-1"), env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await expect(getLinearAuthState(env, "org-1")).resolves.toMatchObject({
      status: "reauthorization_required",
      reason: "oauth_app_revoked",
      details: { eventType: "OAuthApp", eventAction: "revoked" },
    });
    expect(store.has("oauth:token:org-1")).toBe(false);
    expect(mocks.handleAgentSessionEvent).not.toHaveBeenCalled();
  });

  it("records permission-change diagnostics without clearing an existing reauth-required state", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    await setLinearAuthState(env, {
      orgId: "org-1",
      status: "reauthorization_required",
      reason: "oauth_app_revoked",
    });
    const payload = {
      type: "PermissionChange",
      action: "teamAccessChanged",
      organizationId: "org-1",
      webhookTimestamp: Date.now(),
      data: {
        canAccessAllPublicTeams: false,
        addedTeamIds: [],
        removedTeamIds: [],
      },
    };

    const res = await app.fetch(await makeWebhookRequest(payload, "delivery-auth-2"), env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await expect(getLinearAuthState(env, "org-1")).resolves.toMatchObject({
      status: "reauthorization_required",
      reason: "oauth_app_revoked",
      details: {
        eventType: "PermissionChange",
        eventAction: "teamAccessChanged",
        canAccessAllPublicTeams: false,
        addedTeamIds: [],
        removedTeamIds: [],
      },
    });
    expect(mocks.handleAgentSessionEvent).not.toHaveBeenCalled();
  });

  it("marks permission-change events with removed team access as reauthorization-required", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    const payload = {
      type: "PermissionChange",
      action: "teamAccessChanged",
      organizationId: "org-1",
      webhookTimestamp: Date.now(),
      data: {
        canAccessAllPublicTeams: false,
        addedTeamIds: [],
        removedTeamIds: ["team-1"],
      },
    };

    const res = await app.fetch(await makeWebhookRequest(payload, "delivery-auth-3"), env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await expect(getLinearAuthState(env, "org-1")).resolves.toMatchObject({
      status: "reauthorization_required",
      reason: "permission_team_access_removed",
      details: {
        eventType: "PermissionChange",
        eventAction: "teamAccessChanged",
        canAccessAllPublicTeams: false,
        addedTeamIds: [],
        removedTeamIds: ["team-1"],
      },
    });
    expect(mocks.handleAgentSessionEvent).not.toHaveBeenCalled();
  });

  it("requires Linear-Delivery before processing auth-health webhooks", async () => {
    const { kv } = createFakeKV();
    const payload = {
      type: "OAuthApp",
      action: "revoked",
      organizationId: "org-1",
      webhookTimestamp: Date.now(),
    };

    const res = await app.fetch(await makeWebhookRequest(payload), makeLinearBotEnv(kv));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing Linear-Delivery header" });
    await expect(getLinearAuthState(makeLinearBotEnv(kv), "org-1")).resolves.toBeNull();
  });

  it("requires webhookTimestamp before processing auth-health webhooks", async () => {
    const { kv } = createFakeKV();
    const payload = {
      type: "OAuthApp",
      action: "revoked",
      organizationId: "org-1",
    };

    const res = await app.fetch(
      await makeWebhookRequest(payload, "delivery-auth-4"),
      makeLinearBotEnv(kv)
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid payload" });
    await expect(getLinearAuthState(makeLinearBotEnv(kv), "org-1")).resolves.toBeNull();
  });

  it("rejects stale auth-health webhook payloads before handling them", async () => {
    const { kv } = createFakeKV();
    const ctx = makeExecutionContext();
    const payload = {
      type: "OAuthApp",
      action: "revoked",
      organizationId: "org-1",
      webhookTimestamp: Date.now() - 5 * 60 * 1000,
    };

    const res = await app.fetch(
      await makeWebhookRequest(payload, "delivery-stale"),
      makeLinearBotEnv(kv),
      ctx
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Stale webhook payload" });
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(mocks.handleAgentSessionEvent).not.toHaveBeenCalled();
  });
});
