import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateInternalToken } from "./auth/internal";
import { UserStore } from "./db/user-store";
import { handleRequest } from "./router";

vi.mock("./db/user-store", () => ({
  UserStore: vi.fn(),
}));

describe("session prompt identity enrichment", () => {
  const secret = "test-internal-secret";

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
        scmIdentity: {
          userId: "1001",
          login: "ada",
          name: "Trusted Ada",
          email: "1001+ada@users.noreply.github.com",
        },
      });
      return Response.json({ status: "queued" });
    });
    const statement = {
      bind: vi.fn(() => statement),
      first: vi.fn(async () => null),
      all: vi.fn(async () => ({ results: [] })),
      run: vi.fn(async () => ({ meta: { changes: 0 } })),
    };
    const token = await generateInternalToken(secret);

    const response = await handleRequest(
      new Request("https://test.local/sessions/session-1/prompt", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ content: "Fix the bug", authorId: "user-1" }),
      }),
      {
        INTERNAL_CALLBACK_SECRET: secret,
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
      } as never
    );

    expect(response.status).toBe(200);
    expect(sessionFetch).toHaveBeenCalledOnce();
  });

  it("clears attribution when the linked GitHub identity cannot be resolved", async () => {
    vi.mocked(UserStore).mockImplementation(function () {
      return {
        getUserById: async () => {
          throw new Error("D1 unavailable");
        },
      } as never;
    });
    const sessionFetch = vi.fn(async (request: Request) => {
      const body = (await request.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        authorId: "user-1",
        scmIdentity: null,
      });
      return Response.json({ status: "queued" });
    });
    const statement = {
      bind: vi.fn(() => statement),
      first: vi.fn(async () => null),
      all: vi.fn(async () => ({ results: [] })),
      run: vi.fn(async () => ({ meta: { changes: 0 } })),
    };
    const token = await generateInternalToken(secret);

    const response = await handleRequest(
      new Request("https://test.local/sessions/session-1/prompt", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ content: "Fix the bug", authorId: "user-1" }),
      }),
      {
        INTERNAL_CALLBACK_SECRET: secret,
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
      } as never
    );

    expect(response.status).toBe(200);
    expect(sessionFetch).toHaveBeenCalledOnce();
  });
});
