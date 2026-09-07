import { beforeEach, describe, expect, it, vi } from "vitest";

import { UserStore } from "./db/user-store";
import { resolveGitHubEnrichmentForRequest } from "./session/identity";
import {
  fakeSessionRuntimeDispatch,
  handleRequest,
  signedServiceRequest,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "./router.test-support";

vi.mock("./db/user-store", () => ({
  UserStore: vi.fn(),
}));

vi.mock("./session/identity", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveGitHubEnrichmentForRequest: vi.fn(),
  };
});

vi.mock("./auth/user/runtime", () => ({
  getUserAuth: vi.fn(() => ({
    api: {
      listUserAccounts: vi.fn(async () => [
        {
          providerId: "github",
          accountId: "583231",
          userId: "user-1",
        },
      ]),
    },
  })),
}));

vi.mock("./auth/user/session-authenticator", () => ({
  SessionIntegrityError: class SessionIntegrityError extends Error {},
  authenticateSession: vi.fn(async () => ({
    userId: "user-1",
    authentication: {
      mechanism: "browser_session",
      credentialId: "session-1",
      channel: { kind: "sig1", service: "web" },
    },
  })),
}));

function userPromptRequest(body: Record<string, unknown>): Promise<Request> {
  return signedServiceRequest("https://test.local/sessions/session-1/prompt", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { Cookie: "__Secure-openinspect.session_token=session.signature" },
  });
}

function createEnv(sessionFetch: (request: Request) => Promise<Response>): Record<string, unknown> {
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => ({
      user_id: "user-1",
      suspended_at: null,
      assigned: 1,
      role_id: "role_builtin_administrator",
      role_key: "administrator",
      role_name: "Administrator",
    })),
    all: vi.fn(async () => ({
      results: [{ permission_id: "sessions.collaborate" }],
    })),
    run: vi.fn(async () => ({ meta: { changes: 0 } })),
  };
  return {
    ...TEST_SERVICE_SECRETS,
    SCM_PROVIDER: "github",
    DB: {
      prepare: vi.fn(() => statement),
      batch: vi.fn(),
      exec: vi.fn(),
      dump: vi.fn(),
    },
    SESSION: fakeSessionRuntimeDispatch(sessionFetch),
  };
}

describe("session prompt identity enrichment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enriches a web prompt from the canonical linked GitHub identity", async () => {
    const getUserById = vi.fn(async () => ({ id: "relinked-user", displayName: "Other User" }));
    vi.mocked(UserStore).mockImplementation(function () {
      return {
        getUserById,
      } as never;
    });
    vi.mocked(resolveGitHubEnrichmentForRequest).mockResolvedValue({
      scmUserId: "1001",
      scmLogin: "ada",
      displayName: "Trusted Ada",
      email: "1001+ada@users.noreply.github.com",
    });
    const sessionFetch = vi.fn(async (request: Request) => {
      const body = (await request.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        authorId: "user-1",
        canonicalUserId: "user-1",
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
      await userPromptRequest({ content: "Fix the bug" }),
      createEnv(sessionFetch) as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(200);
    expect(sessionFetch).toHaveBeenCalledOnce();
    expect(getUserById).not.toHaveBeenCalled();
    expect(resolveGitHubEnrichmentForRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "user-1",
      expect.anything()
    );
  });

  it("preserves stored enrichment when the GitHub identity lookup is unavailable", async () => {
    vi.mocked(resolveGitHubEnrichmentForRequest).mockRejectedValue(new Error("D1 unavailable"));
    const sessionFetch = vi.fn(async (request: Request) => {
      const body = (await request.json()) as Record<string, unknown>;
      expect(body.authorId).toBe("user-1");
      expect(body).not.toHaveProperty("scmEnrichment");
      return Response.json({ status: "queued" });
    });
    const response = await handleRequest(
      await userPromptRequest({ content: "Fix the bug" }),
      createEnv(sessionFetch) as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(200);
    expect(sessionFetch).toHaveBeenCalledOnce();
  });

  it("leaves stored enrichment unchanged when no linked GitHub identity exists", async () => {
    vi.mocked(resolveGitHubEnrichmentForRequest).mockResolvedValue(null);
    const sessionFetch = vi.fn(async (request: Request) => {
      const body = (await request.json()) as Record<string, unknown>;
      expect(body.authorId).toBe("user-1");
      expect(body).not.toHaveProperty("scmEnrichment");
      return Response.json({ status: "queued" });
    });
    const response = await handleRequest(
      await userPromptRequest({ content: "Fix the bug" }),
      createEnv(sessionFetch) as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(200);
    expect(sessionFetch).toHaveBeenCalledOnce();
  });

  it("rejects a caller-asserted authorId without forwarding to the runtime", async () => {
    const sessionFetch = vi.fn(async () => Response.json({ status: "queued" }));
    const response = await handleRequest(
      await userPromptRequest({ content: "Fix the bug", authorId: "someone-else" }),
      createEnv(sessionFetch) as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Field 'authorId' is not accepted from verified callers",
    });
    expect(sessionFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["slack-bot", "slack:U123"],
    ["github-bot", "github:123"],
    ["linear-bot", "linear:actor-123"],
  ] as const)(
    "keeps the admitted %s actor when a later identity lookup would relink it",
    async (service, actor) => {
      const getIdentity = vi
        .fn()
        .mockResolvedValueOnce({ userId: "user-1" })
        .mockResolvedValue({ userId: "relinked-user" });
      vi.mocked(UserStore).mockImplementation(function () {
        return { getIdentity } as never;
      });
      vi.mocked(resolveGitHubEnrichmentForRequest).mockResolvedValue(null);
      const sessionFetch = vi.fn(async (request: Request) => {
        expect(await request.json()).toMatchObject({ authorId: actor, canonicalUserId: "user-1" });
        return Response.json({ status: "queued" });
      });
      const response = await handleRequest(
        await signedServiceRequest("https://test.local/sessions/session-1/prompt", {
          method: "POST",
          service,
          actor,
          body: JSON.stringify({ content: "Continue" }),
        }),
        createEnv(sessionFetch) as never,
        TEST_BACKGROUND_TASK_CONTEXT
      );
      expect(response.status).toBe(200);
      expect(getIdentity).toHaveBeenCalledOnce();
      expect(resolveGitHubEnrichmentForRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        "user-1",
        expect.anything()
      );
      expect(sessionFetch).toHaveBeenCalledOnce();
    }
  );

  it("continues rejecting actorless bot prompts before credential enrichment", async () => {
    const sessionFetch = vi.fn(async () => Response.json({ status: "queued" }));
    const response = await handleRequest(
      await signedServiceRequest("https://test.local/sessions/session-1/prompt", {
        method: "POST",
        service: "github-bot",
        body: JSON.stringify({ content: "Continue" }),
      }),
      createEnv(sessionFetch) as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );
    expect(response.status).toBe(403);
    expect(resolveGitHubEnrichmentForRequest).not.toHaveBeenCalled();
    expect(sessionFetch).not.toHaveBeenCalled();
  });
});
