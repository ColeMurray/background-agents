import { describe, expect, it, vi } from "vitest";

import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";
import { providerIdentityRoutes } from "./provider-identities";
import type { RequestContext } from "./shared";

function createEnv(): Env {
  return {
    DB: {} as D1Database,
  } as Env;
}

function createCtx(): RequestContext {
  return {
    trace_id: "trace-1",
    request_id: "req-1",
    db: {} as SqlDatabase,
    principal: { kind: "service", service: "web", actor: null },
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  };
}

function userCtx(
  canonicalUserId: string,
  provider: "github" | "google" | "slack" | "linear" = "github",
  providerUserId = "12345"
): RequestContext {
  return {
    ...createCtx(),
    principal: {
      kind: "user",
      user: {
        provider,
        providerUserId,
        canonicalUserId,
        participantUserId: canonicalUserId,
      },
      tokenId: "tok-1",
    },
  };
}

async function callProviderIdentityRoute(
  path: string,
  ctx: RequestContext = createCtx(),
  body?: unknown
): Promise<Response> {
  const route = providerIdentityRoutes.find((candidate) => candidate.method === "PUT")!;
  const match = path.match(route.pattern);
  if (!match) throw new Error(`No route match for ${path}`);

  return route.handler(
    new Request(`https://test.local${path}`, {
      method: "PUT",
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    }),
    createEnv(),
    match,
    ctx
  );
}

describe("PUT /provider-identities/:provider/:providerUserId", () => {
  it("denies the web service now that identity creation happens only during token exchange", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await callProviderIdentityRoute(
      "/provider-identities/github/12345",
      createCtx(),
      {
        providerEmail: "victim@example.com",
      }
    );

    expect(response.status).toBe(403);
  });

  it("matches every supported provider identity path and captures the provider", () => {
    const route = providerIdentityRoutes.find((candidate) => candidate.method === "PUT")!;

    for (const [path, provider, providerUserId] of [
      ["/provider-identities/github/12345", "github", "12345"],
      ["/provider-identities/slack/U123", "slack", "U123"],
      ["/provider-identities/linear/abc", "linear", "abc"],
      ["/provider-identities/google/google-sub-1", "google", "google-sub-1"],
    ] as const) {
      const match = path.match(route.pattern);
      expect(match?.groups).toMatchObject({ provider, providerUserId });
    }
  });

  it("rejects unsupported providers before authorization", async () => {
    const response = await callProviderIdentityRoute("/provider-identities/gitlab/U123");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "provider must be one of: github, slack, linear, google",
    });
  });

  it("rejects blank provider user IDs", async () => {
    const response = await callProviderIdentityRoute("/provider-identities/github/%20%20%20");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "providerUserId is required" });
  });

  it("rejects invalid path encoding for provider user IDs", async () => {
    const response = await callProviderIdentityRoute("/provider-identities/github/%E0%A4%A");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "providerUserId is required" });
  });

  it("returns a matching user's token-fixed canonical id without requiring a body", async () => {
    const response = await callProviderIdentityRoute(
      "/provider-identities/github/12345",
      userCtx("0123456789abcdef0123456789abcdef")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      userId: "0123456789abcdef0123456789abcdef",
    });
  });

  it("ignores body identity fields when resolving the matching user", async () => {
    const response = await callProviderIdentityRoute(
      "/provider-identities/github/12345",
      userCtx("0123456789abcdef0123456789abcdef"),
      { providerEmail: "victim@example.com" }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      userId: "0123456789abcdef0123456789abcdef",
    });
  });

  it("403s a user principal targeting a different identity path", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await callProviderIdentityRoute(
      "/provider-identities/github/999999",
      userCtx("0123456789abcdef0123456789abcdef")
    );

    expect(response.status).toBe(403);
  });
});
