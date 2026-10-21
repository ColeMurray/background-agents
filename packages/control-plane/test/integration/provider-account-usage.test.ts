import { SELF, env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";
import { routeRequest, serviceFetch, serviceRequestHeaders } from "./helpers";
import { ModelProviderAccountStore } from "../../src/db/model-provider-accounts";
import usageFixture from "../fixtures/provider-usage/openai.json";

describe("provider account usage", () => {
  beforeEach(cleanD1Tables);
  afterEach(cleanD1Tables);

  it("reads usage for a connected ChatGPT account without exposing credentials", async () => {
    const created = await serviceFetch("https://test.local/model-provider-accounts", {
      method: "POST",
      body: JSON.stringify({
        provider: "openai",
        displayName: "ChatGPT usage",
        refreshToken: "integration-openai-refresh",
        accountId: "acct-integration",
      }),
    });
    expect(created.status).toBe(201);
    const { account } = await created.json<{ account: { id: string } }>();
    const response = await serviceFetch(
      `https://test.local/model-provider-accounts/${account.id}/usage`
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response.json();
    expect(body, JSON.stringify(body)).toMatchObject({
      usage: {
        status: "available",
        allowed: true,
        limitReached: false,
        windows: [{ id: "primary", usedPercent: 100, resetsAt: 2_000_000_000_000 }],
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/integration-openai|access.token|refresh.token/i);
  });

  it("rejects unauthenticated and service-only callers", async () => {
    const url = `https://test.local/model-provider-accounts/${"1".repeat(32)}/usage`;
    expect((await SELF.fetch(url)).status).toBe(401);
    const denied = await serviceFetch(url, { service: "linear-bot" });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("reuses usage after last-used writes and invalidates it on reconnect", async () => {
    const created = await serviceFetch("https://test.local/model-provider-accounts", {
      method: "POST",
      body: JSON.stringify({
        provider: "openai",
        displayName: "Cached ChatGPT",
        refreshToken: "integration-openai-refresh",
        accountId: "acct-integration",
      }),
    });
    expect(created.status).toBe(201);
    const { account } = await created.json<{ account: { id: string } }>();
    await env.DB.prepare("UPDATE model_provider_accounts SET updated_at = 1 WHERE id = ?")
      .bind(account.id)
      .run();
    const store = new ModelProviderAccountStore(env.DB);
    const before = await store.getLifecycleSnapshot(account.id);
    const url = `https://test.local/model-provider-accounts/${account.id}/usage`;
    let calls = 0;
    const bindings = {
      ...env,
      EGRESS: {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          expect(String(input)).toBe("https://chatgpt.com/backend-api/wham/usage");
          expect(new Headers(init?.headers).get("ChatGPT-Account-Id")).toBe("acct-integration");
          calls++;
          return Response.json({
            ...usageFixture,
            rate_limit: {
              ...usageFixture.rate_limit,
              primary_window: {
                ...usageFixture.rate_limit.primary_window,
                used_percent: calls * 10,
              },
            },
          });
        },
      } as Fetcher,
    };
    const read = async () => {
      const executionCtx = createExecutionContext();
      const response = await routeRequest(
        new Request(url, { headers: await serviceRequestHeaders(url) }),
        bindings,
        executionCtx
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      await waitOnExecutionContext(executionCtx);
      return body;
    };
    const first = await read();
    const after = await store.getLifecycleSnapshot(account.id);
    expect(after!.account.lastUsedAt).not.toBeNull();
    expect(after!.account.updatedAt).toBeGreaterThan(before!.account.updatedAt);
    expect(after!.lifecycleVersion).toBe(before!.lifecycleVersion);
    expect(await read()).toEqual(first);
    expect(calls).toBe(1);

    const reconnected = await serviceFetch(
      `https://test.local/model-provider-accounts/${account.id}/reconnect`,
      {
        method: "POST",
        body: JSON.stringify({
          provider: "openai",
          refreshToken: "integration-openai-reconnected",
          accountId: "acct-integration",
        }),
      }
    );
    expect(reconnected.status).toBe(200);
    expect(await read()).toMatchObject({ usage: { windows: [{ usedPercent: 20 }] } });
    expect(calls).toBe(2);
  });

  it("uses configured egress exclusively and never bypasses its failure", async () => {
    const created = await serviceFetch("https://test.local/model-provider-accounts", {
      method: "POST",
      body: JSON.stringify({
        provider: "openai",
        displayName: "Egress ChatGPT",
        refreshToken: "integration-openai-refresh",
        accountId: "acct-integration",
      }),
    });
    const { account } = await created.json<{ account: { id: string } }>();
    const url = `https://test.local/model-provider-accounts/${account.id}/usage`;
    let calls = 0;
    const response = await routeRequest(
      new Request(url, { headers: await serviceRequestHeaders(url) }),
      {
        ...env,
        EGRESS: {
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            calls++;
            expect(String(input)).toBe("https://chatgpt.com/backend-api/wham/usage");
            expect(new Headers(init?.headers).get("ChatGPT-Account-Id")).toBe("acct-integration");
            return new Response("blocked", { status: 403 });
          },
        } as Fetcher,
      },
      createExecutionContext()
    );
    expect(calls).toBe(1);
    await expect(response.json()).resolves.toEqual({
      usage: { status: "unavailable", reason: "provider_error" },
    });
  });

  it("requires account read permission and permits members to read usage status", async () => {
    const id = "6".repeat(32);
    await env.DB.prepare(
      "INSERT INTO model_provider_accounts (id, provider, display_name, status, created_at, updated_at) VALUES (?, 'openai', 'Private', 'active', 1, 1)"
    )
      .bind(id)
      .run();
    const url = `https://test.local/model-provider-accounts/${id}/usage`;
    const denied = await serviceFetch(url, { as: { userId: "8".repeat(32), role: "viewer" } });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("Cache-Control")).toBe("private, no-store");
    const allowed = await serviceFetch(url, { as: { userId: "9".repeat(32), role: "member" } });
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toEqual({
      usage: { status: "unavailable", reason: "credentials" },
    });
  });

  it("returns unsupported for xAI and unavailable for inactive accounts", async () => {
    const id = "7".repeat(32);
    await env.DB.prepare(
      "INSERT INTO model_provider_accounts (id, provider, display_name, status, created_at, updated_at) VALUES (?, 'xai', 'Grok', 'active', 1, 1)"
    )
      .bind(id)
      .run();
    const url = `https://test.local/model-provider-accounts/${id}/usage`;
    await expect(serviceFetch(url).then((response) => response.json())).resolves.toEqual({
      usage: { status: "unsupported" },
    });
    await env.DB.prepare("UPDATE model_provider_accounts SET status = 'disabled' WHERE id = ?")
      .bind(id)
      .run();
    await expect(serviceFetch(url).then((response) => response.json())).resolves.toEqual({
      usage: { status: "unavailable", reason: "inactive_account" },
    });
    await env.DB.prepare("UPDATE model_provider_accounts SET archived_at = 2 WHERE id = ?")
      .bind(id)
      .run();
    expect((await serviceFetch(url)).status).toBe(404);
  });
});
