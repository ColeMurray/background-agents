import { beforeEach, describe, expect, it, vi } from "vitest";

import { UserStore } from "./db/user-store";
import { handleRequest } from "./router";

vi.mock("./db/user-store", () => ({
  UserStore: vi.fn(),
}));

// Prompts attribute to the verified principal, never a body field. Resolve
// the bearer token to a fixed user principal so the tests exercise the
// principal-derived author path through the real router.
vi.mock("./auth/web-session-tokens", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    WebSessionTokenService: vi.fn(function () {
      return {
        verifyAccessToken: async () => ({
          ok: true,
          tokenId: "token-1",
          userId: "user-1",
          provider: "github",
          providerUserId: "583231",
        }),
      };
    }),
  };
});

function userPromptRequest(body: Record<string, unknown>): Request {
  return new Request("https://test.local/sessions/session-1/prompt", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer oi_at_test-token",
    },
    body: JSON.stringify(body),
  });
}

function createEnv(sessionFetch: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => null),
    all: vi.fn(async () => ({ results: [] })),
    run: vi.fn(async () => ({ meta: { changes: 0 } })),
  };
  return {
    SCM_PROVIDER: "github",
    DB: {
      prepare: vi.fn(() => statement),
      batch: vi.fn(),
      exec: vi.fn(),
      dump: vi.fn(),
    },
    SESSION: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: sessionFetch }),
    },
  };
}

describe("session prompt identity enrichment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enriches a web prompt from the canonical linked GitHub identity", async () => {
    vi.mocked(UserStore).mockImplementation(function () {
      return {
        getUserById: async () => ({ id: "user-1", displayName: "Trusted Ada" }),
        getIdentitiesForUser: async () => [
          {
            provider: "github",
            providerUserId: "1001",
            providerLogin: "ada",
            providerEmail: "private@example.com",
          },
        ],
      } as never;
    });
    const sessionFetch = vi.fn(async (request: Request) => {
      const body = (await request.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        authorId: "user-1",
        scmEnrichment: {
          userId: "1001",
          login: "ada",
          name: "Trusted Ada",
          email: "1001+ada@users.noreply.github.com",
          accessTokenEncrypted: null,
          refreshTokenEncrypted: null,
          tokenExpiresAt: null,
        },
      });
      return Response.json({ status: "queued" });
    });
    const response = await handleRequest(
      userPromptRequest({ content: "Fix the bug" }),
      createEnv(sessionFetch) as never
    );

    expect(response.status).toBe(200);
    expect(sessionFetch).toHaveBeenCalledOnce();
  });

  it("preserves stored enrichment when the GitHub identity lookup is unavailable", async () => {
    vi.mocked(UserStore).mockImplementation(function () {
      return {
        getUserById: async () => {
          throw new Error("D1 unavailable");
        },
      } as never;
    });
    const sessionFetch = vi.fn(async (request: Request) => {
      const body = (await request.json()) as Record<string, unknown>;
      expect(body.authorId).toBe("user-1");
      expect(body).not.toHaveProperty("scmEnrichment");
      return Response.json({ status: "queued" });
    });
    const response = await handleRequest(
      userPromptRequest({ content: "Fix the bug" }),
      createEnv(sessionFetch) as never
    );

    expect(response.status).toBe(200);
    expect(sessionFetch).toHaveBeenCalledOnce();
  });

  it("leaves stored enrichment unchanged when no linked GitHub identity exists", async () => {
    vi.mocked(UserStore).mockImplementation(function () {
      return {
        getUserById: async () => ({ id: "user-1", displayName: "Unlinked User" }),
        getIdentitiesForUser: async () => [],
      } as never;
    });
    const sessionFetch = vi.fn(async (request: Request) => {
      const body = (await request.json()) as Record<string, unknown>;
      expect(body.authorId).toBe("user-1");
      expect(body).not.toHaveProperty("scmEnrichment");
      return Response.json({ status: "queued" });
    });
    const response = await handleRequest(
      userPromptRequest({ content: "Fix the bug" }),
      createEnv(sessionFetch) as never
    );

    expect(response.status).toBe(200);
    expect(sessionFetch).toHaveBeenCalledOnce();
  });

  it("rejects a caller-asserted authorId without forwarding to the runtime", async () => {
    const sessionFetch = vi.fn(async () => Response.json({ status: "queued" }));
    const response = await handleRequest(
      userPromptRequest({ content: "Fix the bug", authorId: "someone-else" }),
      createEnv(sessionFetch) as never
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Field 'authorId' is not accepted from verified callers",
    });
    expect(sessionFetch).not.toHaveBeenCalled();
  });
});
