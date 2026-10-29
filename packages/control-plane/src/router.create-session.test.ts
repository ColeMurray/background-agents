import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateEncryptionKey } from "./auth/crypto";
import { ModelPreferencesStore } from "./db/model-preferences";
import { SessionIndexStore } from "./db/session-index";
import { UserStore } from "./db/user-store";
import {
  fakeSessionRuntimeDispatch,
  handleRequest,
  signedServiceRequest,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "./router.test-support";
import { resolveRepoOrError } from "./routes/shared";
import { resolveManagedSkills } from "./session/skill-resolution";
import { resolveSessionProviderAuth } from "./session/provider-account-resolution";
import { resolveEnvironmentTarget, resolveSessionRepositories } from "./repos/resolve";
import { TeamStore } from "./db/teams";
import { SANDBOX_PROVIDER_NAMES } from "@open-inspect/shared/types/integrations";

const { getAccessToken } = vi.hoisted(() => ({
  getAccessToken: vi.fn(async () => ({
    accessToken: "better-auth-access-token",
    accessTokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
  })),
}));

const environmentMocks = vi.hoisted(() => ({ getById: vi.fn() }));

vi.mock("./auth/user/runtime", () => ({
  getUserAuth: vi.fn(() => ({
    api: {
      listUserAccounts: vi.fn(async () => []),
      getAccessToken,
      accountInfo: vi.fn(async () => ({
        account: {
          id: "github-account-2002",
          providerId: "github",
          accountId: "2002",
        },
        user: { name: "Trusted Ada" },
        data: {
          provider: "github",
          issuer: "https://github.com",
          subject: "2002",
          login: "ada",
          displayName: "Trusted Ada",
          verifiedEmails: ["private@example.com"],
          primaryEmail: "private@example.com",
        },
      })),
    },
  })),
}));

vi.mock("./db/session-index", () => ({
  SessionIndexStore: vi.fn(),
}));

vi.mock("./db/user-store", () => ({
  UserStore: vi.fn(),
}));

vi.mock("./db/environments", () => ({
  EnvironmentStore: vi.fn().mockImplementation(function () {
    return environmentMocks;
  }),
}));

vi.mock("./session/skill-resolution", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveManagedSkills: vi.fn(),
  };
});

vi.mock("./session/provider-account-resolution", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, resolveSessionProviderAuth: vi.fn() };
});

vi.mock("./routes/shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveRepoOrError: vi.fn(),
  };
});

vi.mock("./repos/resolve", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveEnvironmentTarget: vi.fn(),
    resolveSessionRepositories: vi.fn(),
  };
});

describe("Codex public session creation", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(TeamStore.prototype, "isActive").mockResolvedValue(true);
    environmentMocks.getById.mockResolvedValue({ id: "env_1", owner_team_id: null });
    vi.mocked(resolveManagedSkills).mockResolvedValue({
      selection: { mode: "all" },
      resolverVersion: 1,
      manifestSha256: "0".repeat(64),
      resolvedAt: 1,
      skills: [],
    });
    vi.mocked(resolveSessionProviderAuth).mockResolvedValue([
      { provider: "openai", authMode: "api_key", selectionSource: "fallback_api_key" },
      { provider: "xai", authMode: "api_key", selectionSource: "fallback_api_key" },
    ]);
    vi.mocked(resolveRepoOrError).mockResolvedValue({
      repoId: 12345,
      defaultBranch: "main",
    } as never);
    vi.mocked(resolveEnvironmentTarget).mockResolvedValue([
      { repoOwner: "acme", repoName: "environment-repo", baseBranch: "main" },
    ]);
    vi.mocked(resolveSessionRepositories).mockImplementation(async (_env, repositories) =>
      repositories.map((repository, index) => ({
        ...repository,
        repoId: 12345 + index,
        baseBranch: repository.baseBranch ?? "main",
      }))
    );
    // Default identity fixture: the slack-bot's asserted actor resolves to an
    // already-known canonical user with no linked GitHub identity.
    vi.mocked(UserStore).mockImplementation(function () {
      return {
        getIdentity: async () => ({ userId: "user-1" }),
        getIdentitiesForUser: async () => [],
      } as never;
    });
  });

  // Session creation requires a user identity, so router-level tests
  // authenticate as the slack-bot asserting a verified actor — the principal
  // (never the body) is what identity derives from.
  async function createSessionRequestWithBody(
    env: Record<string, unknown>,
    body: Record<string, unknown>
  ): Promise<Response> {
    return handleRequest(
      await signedServiceRequest("https://test.local/sessions", {
        method: "POST",
        body: JSON.stringify(body),
        service: "slack-bot",
        actor: "slack:U0123",
      }),
      env as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );
  }

  function createEnv(
    initFetch: (request: Request) => Promise<Response>,
    permissions = ["sessions.create", "repositories.use", "environments.use"]
  ): Record<string, unknown> {
    const statement = {
      bind: vi.fn(() => statement),
      first: vi.fn(async () => null),
      all: vi.fn(async () => ({ results: [] })),
      run: vi.fn(async () => ({ meta: { changes: 0 } })),
    };

    return {
      ...TEST_SERVICE_SECRETS,
      SCM_PROVIDER: "github",
      // GitHub-identity enrichment reads the token store unconditionally, so
      // the env must carry valid key material (the db stub answers "no rows").
      TOKEN_ENCRYPTION_KEY: generateEncryptionKey(),
      DB: {
        prepare: vi.fn((sql: string) => {
          if (sql.includes("FROM users u") && sql.includes("user_role_assignments")) {
            let authorizedUserId = "user-1";
            const authorizationStatement = {
              bind: vi.fn((userId: string) => {
                authorizedUserId = userId;
                return authorizationStatement;
              }),
              first: vi.fn(async () => ({
                user_id: authorizedUserId,
                suspended_at: null,
                role_id: "role-1",
                role_key: null,
                role_name: "Test Role",
              })),
              all: vi.fn(async () => ({ results: [] })),
            };
            return authorizationStatement;
          }
          if (sql.includes("FROM role_permissions")) {
            const permissionStatement = {
              bind: vi.fn(() => permissionStatement),
              first: vi.fn(async () => null),
              all: vi.fn(async () => ({
                results: permissions.map((permission_id) => ({ permission_id })),
              })),
            };
            return permissionStatement;
          }
          if (sql.includes("suspended_at IS NULL")) {
            const activeStatement = {
              bind: vi.fn(() => activeStatement),
              first: vi.fn(async () => ({ active: 1 })),
              all: vi.fn(async () => ({ results: [] })),
              run: vi.fn(async () => ({ meta: { changes: 0 } })),
            };
            return activeStatement;
          }
          return statement;
        }),
        batch: vi.fn(async (statements: readonly unknown[]) =>
          statements.map((_, index) =>
            index === 0 ? { results: [{ total: 0 }] } : { results: [] }
          )
        ),
        exec: vi.fn(),
        dump: vi.fn(),
      },
      SESSION: fakeSessionRuntimeDispatch(initFetch),
    };
  }

  it.each(SANDBOX_PROVIDER_NAMES)("admits Codex on the %s sandbox provider", async (provider) => {
    vi.spyOn(ModelPreferencesStore.prototype, "getEnabledModels").mockResolvedValue([
      "openai/gpt-5.6-sol",
    ]);
    const create = vi.fn().mockResolvedValue(undefined);
    vi.mocked(SessionIndexStore).mockImplementation(function () {
      return { create } as never;
    });
    const initFetch = vi.fn(async (_request: Request) => Response.json({ status: "created" }));
    const response = await createSessionRequestWithBody(
      { ...createEnv(initFetch), SANDBOX_PROVIDER: provider },
      {
        harness: "codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "max",
        providerSelections: { openai: { mode: "api_key" } },
      }
    );
    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        harness: "codex",
        model: "openai/gpt-5.6-sol",
        reasoningEffort: "max",
      })
    );
    const payload = await initFetch.mock.calls[0][0].json();
    expect(payload).toMatchObject({
      harness: "codex",
      model: "openai/gpt-5.6-sol",
      reasoningEffort: "max",
    });
  });
});
