import { beforeEach, describe, expect, it, vi } from "vitest";

import { UserStore } from "./db/user-store";
import { resolveGitHubEnrichmentForRequest } from "./session/identity";
import { handleRequest } from "./router";
import {
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

function createEnv(
  sessionFetch: ReturnType<typeof vi.fn>,
  options: { sessionModel?: string; enabledModels?: string[] } = {}
): Record<string, unknown> {
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => {
      const query = statementQuery;
      if (query.includes("SELECT * FROM sessions")) {
        return {
          id: "session-1",
          title: null,
          repo_owner: null,
          repo_name: null,
          model: options.sessionModel ?? "openai/gpt-5.6-sol",
          reasoning_effort: "high",
          base_branch: null,
          status: "active",
          parent_session_id: null,
          root_session_id: "session-1",
          spawn_source: "user",
          spawn_depth: 0,
          automation_id: null,
          automation_run_id: null,
          scm_login: null,
          user_id: "user-1",
          total_cost: 0,
          active_duration_ms: 0,
          message_count: 0,
          pr_count: 0,
          environment_id: null,
          external_request_fingerprint: null,
          external_bootstrap_snapshot: null,
          created_at: 1,
          updated_at: 1,
        };
      }
      if (query.includes("SELECT enabled_models FROM model_preferences")) {
        return options.enabledModels
          ? { enabled_models: JSON.stringify(options.enabledModels) }
          : null;
      }
      return {
        user_id: "user-1",
        suspended_at: null,
        assigned: 1,
        role_id: "role_builtin_administrator",
        role_key: "administrator",
        role_name: "Administrator",
      };
    }),
    all: vi.fn(async () => ({
      results: [{ permission_id: "sessions.collaborate" }],
    })),
    run: vi.fn(async () => ({ meta: { changes: 0 } })),
  };
  let statementQuery = "";
  return {
    ...TEST_SERVICE_SECRETS,
    SCM_PROVIDER: "github",
    DB: {
      prepare: vi.fn((query: string) => {
        statementQuery = query;
        return statement;
      }),
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
      await userPromptRequest({ content: "Fix the bug" }),
      createEnv(sessionFetch) as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(200);
    expect(sessionFetch).toHaveBeenCalledOnce();
  });

  it("leaves stored enrichment unchanged when no linked GitHub identity exists", async () => {
    vi.mocked(UserStore).mockImplementation(function () {
      return {
        getUserById: async () => ({ id: "user-1", displayName: "Unlinked User" }),
      } as never;
    });
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

  it("applies canonical model enablement and reasoning policy before web dispatch", async () => {
    const sessionFetch = vi.fn(async () => Response.json({ status: "queued" }));
    const disabled = await handleRequest(
      await userPromptRequest({ content: "Fix the bug" }),
      createEnv(sessionFetch, { enabledModels: ["anthropic/claude-sonnet-4-6"] }) as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );
    expect(disabled.status).toBe(400);
    await expect(disabled.json()).resolves.toEqual({
      error: 'Model "openai/gpt-5.6-sol" is not enabled',
    });

    const invalidReasoning = await handleRequest(
      await userPromptRequest({ content: "Fix the bug", reasoningEffort: "low" }),
      createEnv(sessionFetch, { sessionModel: "anthropic/claude-haiku-4-5" }) as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );
    expect(invalidReasoning.status).toBe(400);
    await expect(invalidReasoning.json()).resolves.toEqual({
      error: 'Reasoning effort "low" is not supported by model "anthropic/claude-haiku-4-5"',
    });
    expect(sessionFetch).not.toHaveBeenCalled();
  });
});
