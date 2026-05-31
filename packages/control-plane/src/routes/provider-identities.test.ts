import { beforeEach, describe, expect, it, vi } from "vitest";
import { providerIdentityRoutes } from "./provider-identities";
import type { RequestContext } from "./shared";
import type { Env } from "../types";

const mockUserStore = {
  resolveOrCreateUser: vi.fn(),
};

vi.mock("../db/user-store", () => ({
  UserStore: vi.fn().mockImplementation(() => mockUserStore),
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

    it("rejects unsupported providers", async () => {
      const response = await callProviderIdentityRoute("/provider-identities/slack/U123", {});

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "provider must be github" });
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
