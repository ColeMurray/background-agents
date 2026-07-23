import { beforeEach, describe, expect, it, vi } from "vitest";
import { providerIdentityRoutes } from "./provider-identities";
import type { RequestContext } from "./shared";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";

const mockUserStore = {
  resolveOrCreateUser: vi.fn(),
};

vi.mock("../db/user-store", () => ({
  UserStore: vi.fn().mockImplementation(function () {
    return mockUserStore;
  }),
}));

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
    // The real upsert caller: web's BFF during the OAuth sign-in flow. Only
    // it (or the matching user) passes enforceProviderIdentityPath.
    principal: { kind: "service", service: "web", actor: null },
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  };
}

async function callProviderIdentityRoute(path: string, body: unknown): Promise<Response> {
  const route = providerIdentityRoutes.find((candidate) => candidate.method === "PUT")!;
  const match = path.match(route.pattern);
  if (!match) throw new Error(`No route match for ${path}`);

  return route.handler(
    new Request(`https://test.local${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    createEnv(),
    match,
    createCtx()
  );
}

async function callProviderIdentityRouteWithoutBody(path: string): Promise<Response> {
  const route = providerIdentityRoutes.find((candidate) => candidate.method === "PUT")!;
  const match = path.match(route.pattern);
  if (!match) throw new Error(`No route match for ${path}`);

  return route.handler(
    new Request(`https://test.local${path}`, { method: "PUT" }),
    createEnv(),
    match,
    createCtx()
  );
}

describe("provider identity routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserStore.resolveOrCreateUser.mockResolvedValue({
      id: "0123456789abcdef0123456789abcdef",
      displayName: "Ada",
      email: "ada@example.com",
      isNew: false,
    });
  });

  describe("PUT /provider-identities/:provider/:providerUserId", () => {
    it("upserts a GitHub identity and returns its canonical user ID", async () => {
      const response = await callProviderIdentityRoute("/provider-identities/github/12345", {
        providerLogin: "ada",
        providerEmail: "ada@example.com",
        displayName: "Ada Lovelace",
        avatarUrl: "https://avatars.githubusercontent.com/u/12345",
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        userId: "0123456789abcdef0123456789abcdef",
      });
      expect(mockUserStore.resolveOrCreateUser).toHaveBeenCalledWith({
        provider: "github",
        providerUserId: "12345",
        providerLogin: "ada",
        providerEmail: "ada@example.com",
        displayName: "Ada Lovelace",
        avatarUrl: "https://avatars.githubusercontent.com/u/12345",
      });
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

    it("upserts a non-GitHub (Google) identity using the provider from the path", async () => {
      const response = await callProviderIdentityRoute("/provider-identities/google/google-sub-1", {
        providerEmail: "pm@corp.com",
        displayName: "PM Person",
        avatarUrl: "https://lh3.googleusercontent.com/pic",
      });

      expect(response.status).toBe(200);
      expect(mockUserStore.resolveOrCreateUser).toHaveBeenCalledWith({
        provider: "google",
        providerUserId: "google-sub-1",
        providerLogin: undefined,
        providerEmail: "pm@corp.com",
        displayName: "PM Person",
        avatarUrl: "https://lh3.googleusercontent.com/pic",
      });
    });

    it("rejects unsupported providers with 400 without resolving a user", async () => {
      const response = await callProviderIdentityRoute("/provider-identities/gitlab/U123", {});

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "provider must be one of: github, slack, linear, google",
      });
      expect(mockUserStore.resolveOrCreateUser).not.toHaveBeenCalled();
    });

    it("rejects requests with no request body", async () => {
      const response = await callProviderIdentityRouteWithoutBody(
        "/provider-identities/github/12345"
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body" });
      expect(mockUserStore.resolveOrCreateUser).not.toHaveBeenCalled();
    });

    it("rejects non-object JSON bodies", async () => {
      const response = await callProviderIdentityRoute("/provider-identities/github/12345", null);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Request body must be an object" });
      expect(mockUserStore.resolveOrCreateUser).not.toHaveBeenCalled();
    });

    it("rejects blank provider user IDs", async () => {
      const response = await callProviderIdentityRoute("/provider-identities/github/%20%20%20", {});

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "providerUserId is required" });
      expect(mockUserStore.resolveOrCreateUser).not.toHaveBeenCalled();
    });

    it("rejects invalid path encoding for provider user IDs", async () => {
      const response = await callProviderIdentityRoute("/provider-identities/github/%E0%A4%A", {});

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "providerUserId is required" });
      expect(mockUserStore.resolveOrCreateUser).not.toHaveBeenCalled();
    });

    it("rejects unexpected non-canonical resolved IDs", async () => {
      mockUserStore.resolveOrCreateUser.mockResolvedValue({
        id: "user-1",
        displayName: null,
        email: null,
        isNew: false,
      });

      const response = await callProviderIdentityRoute("/provider-identities/github/12345", {});

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "Resolved user ID is invalid" });
    });
  });
});
