/**
 * Unit tests for automation CRUD route handlers.
 *
 * Tests run in Node (not workerd) with mocked AutomationStore and source
 * control. Handler functions are extracted from the exported automationRoutes
 * array and invoked directly, bypassing the auth middleware.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { automationRoutes } from "./automations";
import { HttpError, resolveRepoOrError, type RequestContext } from "./shared";
import type { Principal } from "../auth/principal";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";
import { routePathPattern, TEST_BACKGROUND_TASK_CONTEXT } from "../router.test-support";
import {
  AutomationExecutionUnauthorizedError,
  AutomationTriggerBlockedError,
} from "../scheduler/scheduler";
import { PERMISSION_IDS, type PermissionId } from "@open-inspect/shared/rbac";

const mockProviderAdapterGet = vi.hoisted(() => vi.fn());
const mockResolveGitHubCredentialAuthority = vi.hoisted(() => vi.fn());
const mockResolveGitHubEnrichmentForRequest = vi.hoisted(() => vi.fn());

vi.mock("../auth/model-provider-account-default-adapters", () => ({
  modelProviderAccountAdapterRegistry: { get: mockProviderAdapterGet },
}));

vi.mock("../source-control/github-credential-authority", () => ({
  resolveGitHubCredentialAuthority: mockResolveGitHubCredentialAuthority,
}));

vi.mock("../session/identity", () => ({
  resolveGitHubEnrichmentForRequest: mockResolveGitHubEnrichmentForRequest,
}));

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockStore = {
  list: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  getActiveRunForAutomation: vi.fn(),
  getRunById: vi.fn(),
  getRepositoriesForAutomation: vi.fn(),
  getRepositoriesForAutomationIds: vi.fn(),
  getEnvironmentsForAutomation: vi.fn(),
  getEnvironmentsForAutomationIds: vi.fn(),
  bindAutomationInsert: vi.fn(),
  bindAutomationUpdate: vi.fn(),
  bindSoftDelete: vi.fn(),
  bindPause: vi.fn(),
  bindResume: vi.fn(),
  bindRepositoryInserts: vi.fn(),
  bindReplaceRepositories: vi.fn(),
  bindEnvironmentInserts: vi.fn(),
  bindReplaceEnvironments: vi.fn(),
  listInvocations: vi.fn(),
  listRecentExecutionsForAutomationIds: vi.fn(),
};

const mockProviderAuthStore = {
  list: vi.fn(),
  listForAutomationIds: vi.fn(),
  bindInserts: vi.fn(),
  bindReplace: vi.fn(),
};

vi.mock("../db/automation-model-provider-auth", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    AutomationModelProviderAuthStore: vi.fn().mockImplementation(function () {
      return mockProviderAuthStore;
    }),
  };
});

const mockProviderAccountStore = {
  getById: vi.fn(),
};

vi.mock("../db/model-provider-accounts", () => ({
  ModelProviderAccountStore: vi.fn().mockImplementation(function () {
    return mockProviderAccountStore;
  }),
}));

/** Shared D1 batch spy — createEnv wires it as env.DB.batch. */
const mockBatch = vi.fn();
const mockSchedulerTrigger = vi.hoisted(() => vi.fn());
const MockAutomationTriggerBlockedError = vi.hoisted(
  () =>
    class AutomationTriggerBlockedError extends Error {
      constructor() {
        super("An active run already exists");
        this.name = "AutomationTriggerBlockedError";
      }
    }
);
const MockAutomationExecutionUnauthorizedError = vi.hoisted(
  () =>
    class AutomationExecutionUnauthorizedError extends Error {
      constructor() {
        super("Automation owner is not authorized to execute");
        this.name = "AutomationExecutionUnauthorizedError";
      }
    }
);

vi.mock("../scheduler/scheduler", () => ({
  AutomationExecutionUnauthorizedError: MockAutomationExecutionUnauthorizedError,
  AutomationTriggerBlockedError: MockAutomationTriggerBlockedError,
  Scheduler: vi.fn().mockImplementation(function () {
    return { trigger: mockSchedulerTrigger };
  }),
}));

vi.mock("../db/automation-store", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    AutomationStore: vi.fn().mockImplementation(function () {
      return mockStore;
    }),
    toAutomation: vi.fn((row: unknown) => row),
    toAutomationRun: vi.fn((row: unknown) => row),
  };
});

const mockUserStore = {
  resolveOrCreateUser: vi.fn().mockResolvedValue({ id: "resolved-user-1", isNew: false }),
};
vi.mock("../db/user-store", () => ({
  UserStore: vi.fn().mockImplementation(function () {
    return mockUserStore;
  }),
}));

const mockEnvironmentStore = {
  getById: vi.fn(),
};
vi.mock("../db/environments", () => ({
  EnvironmentStore: vi.fn().mockImplementation(function () {
    return mockEnvironmentStore;
  }),
}));

vi.mock("../auth/crypto", () => ({
  generateId: vi.fn(() => "generated-id"),
}));

vi.mock("./shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveRepoOrError: vi.fn().mockResolvedValue({
      repoId: 12345,
      repoOwner: "acme",
      repoName: "web-app",
      defaultBranch: "main",
    }),
  };
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function createEnv(): Env {
  return {
    DB: { batch: mockBatch } as unknown as D1Database,
    SESSION: {} as DurableObjectNamespace,
    DEPLOYMENT_NAME: "test",
    TOKEN_ENCRYPTION_KEY: "test-key",
  } as Env;
}

const USER_PRINCIPAL: Principal = {
  kind: "user",
  userId: "user-1",
};

const SLACK_BOT_PRINCIPAL: Principal = {
  kind: "service",
  service: "slack-bot",
  actor: {
    provider: "slack",
    providerUserId: "U0123",
    canonicalUserId: null,
    participantUserId: "slack:U0123",
  },
};

function createCtx(
  principal: Principal = USER_PRINCIPAL,
  permissions: readonly PermissionId[] = PERMISSION_IDS
): RequestContext {
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => ({ satisfied: 1 })),
    all: vi.fn(async () => ({ results: [] })),
  };
  return {
    trace_id: "trace-1",
    request_id: "req-1",
    principal,
    ...(principal.kind === "user"
      ? {
          authorization: {
            userId: principal.userId,
            suspendedAt: null,
            role: { id: "role_builtin_owner", key: "owner" as const, name: "Owner" },
            permissions: [...permissions],
          },
        }
      : {}),
    db: { batch: mockBatch, prepare: vi.fn(() => statement) } as unknown as SqlDatabase,
    executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  };
}

async function callRoute(
  method: string,
  path: string,
  options?: {
    body?: unknown;
    query?: Record<string, string | string[]>;
    principal?: Principal;
    permissions?: readonly PermissionId[];
  }
): Promise<Response> {
  const route = automationRoutes.find(
    (candidate) => candidate.method === method && routePathPattern(candidate.path).test(path)
  );
  if (!route) throw new Error(`No route found for ${method} ${path}`);
  const match = path.match(routePathPattern(route.path))!;
  const url = new URL(`https://test.local${path}`);
  if (options?.query) {
    for (const [k, v] of Object.entries(options.query)) {
      for (const value of Array.isArray(v) ? v : [v]) {
        url.searchParams.append(k, value);
      }
    }
  }
  const init: RequestInit = { method };
  if (options?.body) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(options.body);
  }
  const ctx = createCtx(options?.principal, options?.permissions);
  const automationRequirement =
    route.authorization.kind === "active-user"
      ? route.authorization.allOf.find((requirement) => requirement.kind === "automation")
      : undefined;
  if (automationRequirement) {
    const automation = await mockStore.getById(
      match.groups?.[automationRequirement.automationIdParam]
    );
    if (!automation)
      return new Response(JSON.stringify({ error: "Automation not found" }), { status: 404 });
    ctx.automationAdmission = { automation };
  }
  return route.handler(new Request(url, init), createEnv(), match, ctx);
}

// ─── Sample data ────────────────────────────────────────────────────────────

const now = Date.now();

const sampleRow = {
  id: "auto-1",
  name: "Daily sync",
  instructions: "Run tests",
  trigger_type: "schedule",
  schedule_cron: "0 9 * * *",
  schedule_tz: "UTC",
  model: "anthropic/claude-sonnet-4-6",
  reasoning_effort: null,
  enabled: 1,
  next_run_at: now,
  consecutive_failures: 0,
  created_by: "user-1",
  created_at: now,
  updated_at: now,
  deleted_at: null,
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("automation route handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Defaults every test can override; re-set here so per-test overrides
    // (mockClear keeps implementations) cannot leak across tests.
    mockStore.getRepositoriesForAutomation.mockResolvedValue([]);
    mockStore.getRepositoriesForAutomationIds.mockResolvedValue(new Map());
    mockStore.getEnvironmentsForAutomation.mockResolvedValue([]);
    mockStore.getEnvironmentsForAutomationIds.mockResolvedValue(new Map());
    mockStore.listRecentExecutionsForAutomationIds.mockResolvedValue(new Map());
    mockProviderAuthStore.list.mockResolvedValue([]);
    mockProviderAuthStore.listForAutomationIds.mockResolvedValue(new Map());
    mockStore.bindAutomationInsert.mockReturnValue({ sql: "insert-automation" });
    mockStore.bindAutomationUpdate.mockReturnValue({ sql: "update-automation" });
    mockStore.bindSoftDelete.mockReturnValue({ sql: "delete-automation" });
    mockStore.bindPause.mockReturnValue({ sql: "pause-automation" });
    mockStore.bindResume.mockReturnValue({ sql: "resume-automation" });
    mockStore.bindRepositoryInserts.mockReturnValue([{ sql: "insert-repositories" }]);
    mockStore.bindReplaceRepositories.mockReturnValue([{ sql: "replace-repositories" }]);
    mockStore.bindEnvironmentInserts.mockReturnValue([{ sql: "insert-environments" }]);
    mockStore.bindReplaceEnvironments.mockReturnValue([{ sql: "replace-environments" }]);
    mockProviderAuthStore.bindInserts.mockReturnValue([{ sql: "insert-provider-auth" }]);
    mockProviderAuthStore.bindReplace.mockReturnValue([{ sql: "replace-provider-auth" }]);
    mockBatch.mockResolvedValue([{ meta: { changes: 1 }, results: [] }]);
    mockSchedulerTrigger.mockResolvedValue({
      invocationId: "inv-1",
      runs: [{ id: "run-1" }],
    });
    mockEnvironmentStore.getById.mockResolvedValue({ id: "env_1", name: "Fullstack" });
    mockProviderAccountStore.getById.mockResolvedValue({
      id: "0123456789abcdef0123456789abcdef",
      provider: "openai",
      status: "active",
      archivedAt: null,
    });
    mockProviderAdapterGet.mockReturnValue({});
    mockResolveGitHubCredentialAuthority.mockResolvedValue({ kind: "legacy" });
    mockResolveGitHubEnrichmentForRequest.mockResolvedValue(null);
    vi.mocked(resolveRepoOrError).mockResolvedValue({
      repoId: 12345,
      repoOwner: "acme",
      repoName: "web-app",
      defaultBranch: "main",
    });
  });

  describe("GET /automations (list)", () => {
    it("returns the first page with default pagination", async () => {
      mockStore.list.mockResolvedValue({
        automations: [sampleRow],
        hasMore: false,
        nextCursor: null,
      });

      const res = await callRoute("GET", "/automations");
      expect(res.status).toBe(200);

      const body = await res.json<{
        automations: unknown[];
        hasMore: boolean;
        nextCursor: string | null;
      }>();
      expect(body.automations).toHaveLength(1);
      expect(body.hasMore).toBe(false);
      expect(body.nextCursor).toBeNull();
      expect(mockStore.list).toHaveBeenCalledWith({ limit: 25, cursor: null });
      expect(mockStore.listRecentExecutionsForAutomationIds).toHaveBeenCalledWith(["auto-1"], 10);
      expect(body.automations[0]).toMatchObject({ recentExecutions: [] });
    });

    it("passes name search and pagination params to the store", async () => {
      mockStore.list.mockResolvedValue({ automations: [], hasMore: false, nextCursor: null });

      await callRoute("GET", "/automations", {
        query: { search: "  Daily sync  ", limit: "10", cursor: "123:auto-9" },
      });

      expect(mockStore.list).toHaveBeenCalledWith({
        nameSearch: "Daily sync",
        limit: 10,
        cursor: { createdAt: 123, id: "auto-9" },
      });
    });

    it("preserves explicit repository filters", async () => {
      mockStore.list.mockResolvedValue({ automations: [], hasMore: false, nextCursor: null });

      await callRoute("GET", "/automations", {
        query: { repoOwner: "acme", repoName: "web-app" },
      });

      expect(mockStore.list).toHaveBeenCalledWith({
        limit: 25,
        cursor: null,
        repoOwner: "acme",
        repoName: "web-app",
      });
    });

    it.each([
      [{ limit: "0" }, "limit"],
      [{ limit: "101" }, "limit"],
      [{ limit: "ten" }, "limit"],
      [{ limit: "1e1" }, "limit"],
      [{ limit: " 10 " }, "limit"],
      [{ limit: ["10", "20"] }, "limit"],
      [{ cursor: "not-a-cursor" }, "cursor"],
      [{ search: "a".repeat(201) }, "Search"],
    ])("rejects invalid pagination params", async (query, expectedField) => {
      const response = await callRoute("GET", "/automations", { query });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringContaining(expectedField),
      });
      expect(mockStore.list).not.toHaveBeenCalled();
    });
  });

  describe("POST /automations (create)", () => {
    const validBody = {
      name: "Daily sync",
      repositories: [{ repoOwner: "acme", repoName: "web-app" }],
      scheduleCron: "0 9 * * *",
      scheduleTz: "UTC",
      instructions: "Run tests",
    };

    it("creates automation with valid input", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("POST", "/automations", { body: validBody });
      expect(res.status).toBe(201);

      // The selection persists as repository rows; the automation row carries
      // no repo columns. Both land in a single atomic batch.
      expect(mockStore.bindRepositoryInserts).toHaveBeenCalledWith(
        "generated-id",
        [{ repo_owner: "acme", repo_name: "web-app", repo_id: 12345, base_branch: "main" }],
        expect.any(Number)
      );
      expect(mockBatch).toHaveBeenCalledTimes(1);
      expect(mockBatch).toHaveBeenCalledWith(
        expect.arrayContaining([{ sql: "insert-automation" }, { sql: "insert-repositories" }])
      );
    });

    it("rejects partial create payloads before persistence", async () => {
      const res = await callRoute("POST", "/automations", {
        body: { instructions: "Run tests" },
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "Invalid automation request" });
      expect(mockStore.bindAutomationInsert).not.toHaveBeenCalled();
      expect(mockBatch).not.toHaveBeenCalled();
    });

    it("persists a complete provider pin map in the create batch", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);
      const providerSelections = {
        openai: {
          mode: "provider_account" as const,
          accountId: "0123456789abcdef0123456789abcdef",
        },
        xai: { mode: "api_key" as const },
      };

      const res = await callRoute("POST", "/automations", {
        body: { ...validBody, providerSelections },
      });

      expect(res.status).toBe(201);
      expect(mockProviderAuthStore.bindInserts).toHaveBeenCalledWith(
        "generated-id",
        providerSelections,
        expect.any(Number)
      );
      expect(mockBatch).toHaveBeenCalledWith(
        expect.arrayContaining([{ sql: "insert-provider-auth" }])
      );
    });

    it.each([
      ["missing account", null, 404],
      ["wrong provider", { provider: "xai", status: "active", archivedAt: null }, 400],
      ["inactive account", { provider: "openai", status: "disabled", archivedAt: null }, 409],
      ["archived account", { provider: "openai", status: "active", archivedAt: 123 }, 409],
    ])("rejects a provider pin for a %s", async (_label, account, status) => {
      mockProviderAccountStore.getById.mockResolvedValue({
        id: "0123456789abcdef0123456789abcdef",
        ...account,
      });
      if (!account) mockProviderAccountStore.getById.mockResolvedValue(null);

      const res = await callRoute("POST", "/automations", {
        body: {
          ...validBody,
          providerSelections: {
            openai: {
              mode: "provider_account",
              accountId: "0123456789abcdef0123456789abcdef",
            },
          },
        },
      });

      expect(res.status).toBe(status);
      expect(mockBatch).not.toHaveBeenCalled();
    });

    it("rejects a provider-account pin when its adapter is unavailable", async () => {
      mockProviderAdapterGet.mockReturnValue(undefined);

      const res = await callRoute("POST", "/automations", {
        body: {
          ...validBody,
          providerSelections: {
            openai: {
              mode: "provider_account",
              accountId: "0123456789abcdef0123456789abcdef",
            },
          },
        },
      });

      expect(res.status).toBe(409);
      expect(mockProviderAccountStore.getById).not.toHaveBeenCalled();
      expect(mockBatch).not.toHaveBeenCalled();
    });

    it.each([{ triggerConfig: {} }, { triggerConfig: { conditions: null } }])(
      "rejects malformed trigger config before persistence",
      async ({ triggerConfig }) => {
        const response = await callRoute("POST", "/automations", {
          body: {
            name: "Webhook automation",
            instructions: "Handle the event",
            triggerType: "webhook",
            triggerConfig,
          },
        });

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          error: expect.stringContaining("triggerConfig.conditions"),
        });
        expect(mockStore.bindAutomationInsert).not.toHaveBeenCalled();
      }
    );

    it("creates a multi-repository automation from the repositories list", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("POST", "/automations", {
        body: {
          name: "Fan-out sync",
          scheduleCron: "0 9 * * *",
          scheduleTz: "UTC",
          instructions: "Run tests",
          repositories: [
            { repoOwner: "Acme", repoName: "Web-App" },
            { repoOwner: "acme", repoName: "api", baseBranch: "develop" },
          ],
        },
      });

      expect(res.status).toBe(201);
      expect(mockStore.bindRepositoryInserts).toHaveBeenCalledWith(
        "generated-id",
        [
          { repo_owner: "acme", repo_name: "web-app", repo_id: 12345, base_branch: "main" },
          { repo_owner: "acme", repo_name: "api", repo_id: 12345, base_branch: "develop" },
        ],
        expect.any(Number)
      );
    });

    it("does not write partial data when repository resolution fails", async () => {
      vi.mocked(resolveRepoOrError).mockImplementation(async (_env, owner, name) => {
        if (name === "api") {
          throw new HttpError("Repository is not installed for the GitHub App", 404);
        }
        return {
          repoId: 12345,
          repoOwner: owner,
          repoName: name,
          defaultBranch: "main",
        };
      });

      await expect(
        callRoute("POST", "/automations", {
          body: {
            ...validBody,
            repositories: [
              { repoOwner: "acme", repoName: "web-app" },
              { repoOwner: "acme", repoName: "api" },
            ],
          },
        })
      ).rejects.toMatchObject({
        status: 404,
        message: "Repository is not installed for the GitHub App",
      });
      expect(mockStore.bindAutomationInsert).not.toHaveBeenCalled();
      expect(mockStore.bindRepositoryInserts).not.toHaveBeenCalled();
      expect(mockBatch).not.toHaveBeenCalled();
    });

    it("reports repository resolution failures in input order", async () => {
      vi.mocked(resolveRepoOrError).mockImplementation(
        (_env, _owner, name) =>
          new Promise((_, reject) => {
            const delay = name === "first" ? 5 : 0;
            setTimeout(() => reject(new HttpError(`failed ${name}`, 404)), delay);
          })
      );

      await expect(
        callRoute("POST", "/automations", {
          body: {
            ...validBody,
            repositories: [
              { repoOwner: "acme", repoName: "first" },
              { repoOwner: "acme", repoName: "second" },
            ],
          },
        })
      ).rejects.toMatchObject({ message: "failed first" });
      expect(mockBatch).not.toHaveBeenCalled();
    });

    it("rejects duplicate repositories in the list", async () => {
      const res = await callRoute("POST", "/automations", {
        body: {
          name: "Dup",
          scheduleCron: "0 9 * * *",
          scheduleTz: "UTC",
          instructions: "Run tests",
          repositories: [
            { repoOwner: "acme", repoName: "web-app" },
            { repoOwner: "ACME", repoName: "Web-App" },
          ],
        },
      });

      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(body.error).toContain("repositories");
      expect(mockBatch).not.toHaveBeenCalled();
    });

    it("rejects multi-repository selections on non-schedule triggers", async () => {
      const res = await callRoute("POST", "/automations", {
        body: {
          name: "Webhook fan-out",
          instructions: "Run tests",
          triggerType: "webhook",
          repositories: [
            { repoOwner: "acme", repoName: "web-app" },
            { repoOwner: "acme", repoName: "api" },
          ],
        },
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Multi-target selections require a schedule trigger",
      });
    });

    it("creates an environment-targeted automation", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("POST", "/automations", {
        body: {
          name: "Workspace sync",
          scheduleCron: "0 9 * * *",
          scheduleTz: "UTC",
          instructions: "Run tests",
          environmentIds: ["env_1", "env_2"],
        },
      });

      expect(res.status).toBe(201);
      expect(mockEnvironmentStore.getById).toHaveBeenCalledWith("env_1");
      expect(mockEnvironmentStore.getById).toHaveBeenCalledWith("env_2");
      expect(mockStore.bindEnvironmentInserts).toHaveBeenCalledWith(
        "generated-id",
        ["env_1", "env_2"],
        expect.any(Number)
      );
      expect(mockBatch).toHaveBeenCalledWith(
        expect.arrayContaining([{ sql: "insert-automation" }, { sql: "insert-environments" }])
      );
    });

    it("creates a mixed repository + environment fan-out", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("POST", "/automations", {
        body: { ...validBody, environmentIds: ["env_1"] },
      });

      expect(res.status).toBe(201);
      expect(mockStore.bindRepositoryInserts).toHaveBeenCalledWith(
        "generated-id",
        [{ repo_owner: "acme", repo_name: "web-app", repo_id: 12345, base_branch: "main" }],
        expect.any(Number)
      );
      expect(mockStore.bindEnvironmentInserts).toHaveBeenCalledWith(
        "generated-id",
        ["env_1"],
        expect.any(Number)
      );
    });

    it("rejects duplicate environment ids", async () => {
      const res = await callRoute("POST", "/automations", {
        body: {
          name: "Dup envs",
          scheduleCron: "0 9 * * *",
          scheduleTz: "UTC",
          instructions: "Run tests",
          environmentIds: ["env_1", "env_1"],
        },
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "environmentIds must not contain duplicates" });
      expect(mockBatch).not.toHaveBeenCalled();
    });

    it("rejects unknown environments, naming every missing one", async () => {
      mockEnvironmentStore.getById.mockResolvedValue(null);

      const res = await callRoute("POST", "/automations", {
        body: {
          name: "Workspace sync",
          scheduleCron: "0 9 * * *",
          scheduleTz: "UTC",
          instructions: "Run tests",
          environmentIds: ["env_a", "env_b"],
        },
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Environment not found: env_a, env_b" });
    });

    it("checks environment-use permission before disclosing whether an environment exists", async () => {
      mockEnvironmentStore.getById.mockResolvedValue(null);

      const res = await callRoute("POST", "/automations", {
        body: {
          name: "Workspace sync",
          scheduleCron: "0 9 * * *",
          scheduleTz: "UTC",
          instructions: "Run tests",
          environmentIds: ["env_missing"],
        },
        permissions: PERMISSION_IDS.filter((permission) => permission !== "environments.use"),
      });

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({
        code: "permission_required",
        permission: "environments.use",
      });
      expect(mockEnvironmentStore.getById).not.toHaveBeenCalled();
    });

    it("rejects malformed environment ids", async () => {
      const res = await callRoute("POST", "/automations", {
        body: {
          name: "Workspace sync",
          scheduleCron: "0 9 * * *",
          scheduleTz: "UTC",
          instructions: "Run tests",
          environmentIds: ["not-an-environment"],
        },
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "environmentIds must be an array of environment ids (env_…)",
      });
      expect(mockEnvironmentStore.getById).not.toHaveBeenCalled();
    });

    it("rejects environments on repo-scoped event triggers", async () => {
      const res = await callRoute("POST", "/automations", {
        body: {
          name: "PR review",
          instructions: "Review",
          triggerType: "github_event",
          eventType: "pull_request.opened",
          repositories: [{ repoOwner: "acme", repoName: "web-app" }],
          environmentIds: ["env_1"],
        },
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Repository-scoped triggers cannot target environments",
      });
    });

    it("rejects multi-target selections on non-schedule triggers", async () => {
      const res = await callRoute("POST", "/automations", {
        body: {
          name: "Webhook fan-out",
          instructions: "Run tests",
          triggerType: "webhook",
          repositories: [{ repoOwner: "acme", repoName: "web-app" }],
          environmentIds: ["env_1"],
        },
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Multi-target selections require a schedule trigger",
      });
    });

    it("enforces the combined target cap", async () => {
      const res = await callRoute("POST", "/automations", {
        body: {
          name: "Too many targets",
          scheduleCron: "0 9 * * *",
          scheduleTz: "UTC",
          instructions: "Run tests",
          repositories: Array.from({ length: 8 }, (_, i) => ({
            repoOwner: "acme",
            repoName: `repo-${i}`,
          })),
          environmentIds: ["env_1", "env_2", "env_3"],
        },
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "At most 10 repositories and environments combined",
      });
    });

    it("creates repo-less automation without repo fields", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("POST", "/automations", {
        body: {
          name: "Incident sweep",
          scheduleCron: "0 9 * * *",
          scheduleTz: "UTC",
          instructions: "Check recent incidents and summarize.",
        },
      });

      expect(res.status).toBe(201);
      expect(mockStore.bindRepositoryInserts).toHaveBeenCalledWith(
        "generated-id",
        [],
        expect.any(Number)
      );
    });

    it("rejects repo-less repo-scoped triggers", async () => {
      const res = await callRoute("POST", "/automations", {
        body: {
          name: "PR review",
          instructions: "Review the PR.",
          triggerType: "github_event",
          eventType: "pull_request.opened",
        },
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Repository-scoped triggers require exactly one repository",
      });
    });

    it("rejects conditions that do not apply to the GitHub event type", async () => {
      const response = await callRoute("POST", "/automations", {
        body: {
          name: "PR workflow filter",
          instructions: "Review the pull request.",
          triggerType: "github_event",
          eventType: "pull_request.opened",
          repositories: [{ repoOwner: "acme", repoName: "web-app" }],
          triggerConfig: {
            conditions: [{ type: "workflow_name", operator: "eq", value: "CI" }],
          },
        },
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'Condition "workflow_name" does not apply to GitHub event pull_request.opened',
      });
      expect(mockStore.bindAutomationInsert).not.toHaveBeenCalled();
    });

    it.each([
      [undefined, "eventType is required for github_event triggers"],
      ["workflow_run.typo", "Unsupported eventType for github_event: workflow_run.typo"],
    ])("rejects an invalid GitHub event type without conditions", async (eventType, message) => {
      const response = await callRoute("POST", "/automations", {
        body: {
          name: "GitHub watcher",
          instructions: "Inspect the event.",
          triggerType: "github_event",
          eventType,
          repositories: [{ repoOwner: "acme", repoName: "web-app" }],
        },
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: message });
      expect(mockStore.bindAutomationInsert).not.toHaveBeenCalled();
    });

    it("stores the user principal's canonical id without consulting the user store", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("POST", "/automations", { body: validBody });

      expect(res.status).toBe(201);
      expect(mockUserStore.resolveOrCreateUser).not.toHaveBeenCalled();
      expect(mockStore.bindAutomationInsert).toHaveBeenCalledWith(
        expect.objectContaining({ created_by: "user-1", user_id: "user-1" })
      );
    });

    it("fails closed when a bot actor bypasses admission", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("POST", "/automations", {
        body: {
          ...validBody,
          actorDisplayName: "Alice",
          actorEmail: "alice@corp.com",
          actorAvatarUrl: "https://avatars.test/alice.png",
        },
        principal: SLACK_BOT_PRINCIPAL,
      });

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toEqual({ error: "Failed to resolve session identity" });
      expect(mockUserStore.resolveOrCreateUser).not.toHaveBeenCalled();
      expect(mockStore.bindAutomationInsert).not.toHaveBeenCalled();
    });

    it("rejects forbidden body identity fields", async () => {
      const res = await callRoute("POST", "/automations", {
        body: { ...validBody, scmUserId: "12345" },
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Field 'scmUserId' is not accepted from verified callers",
      });
      expect(mockBatch).not.toHaveBeenCalled();
    });

    it("stores reasoning effort when valid for the selected model", async () => {
      mockStore.getById.mockResolvedValue({ ...sampleRow, reasoning_effort: "high" });

      const res = await callRoute("POST", "/automations", {
        body: { ...validBody, model: "anthropic/claude-sonnet-4-6", reasoningEffort: "high" },
      });

      expect(res.status).toBe(201);
      expect(mockStore.bindAutomationInsert).toHaveBeenCalledWith(
        expect.objectContaining({ model: "anthropic/claude-sonnet-4-6", reasoning_effort: "high" })
      );
    });

    it("returns 400 for invalid reasoning effort", async () => {
      const res = await callRoute("POST", "/automations", {
        body: { ...validBody, model: "anthropic/claude-sonnet-4-6", reasoningEffort: "xhigh" },
      });

      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(body.error).toContain("reasoning");
    });

    it("returns 400 when name is missing", async () => {
      const res = await callRoute("POST", "/automations", {
        body: { ...validBody, name: "" },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(body.error).toContain("name");
    });

    it("returns 400 when name exceeds 200 chars", async () => {
      const res = await callRoute("POST", "/automations", {
        body: { ...validBody, name: "a".repeat(201) },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(body.error).toContain("200");
    });

    it("returns 400 when instructions is missing", async () => {
      const res = await callRoute("POST", "/automations", {
        body: { ...validBody, instructions: "" },
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when instructions exceeds the maximum length", async () => {
      const res = await callRoute("POST", "/automations", {
        body: { ...validBody, instructions: "x".repeat(15_001) },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(body.error).toContain("15000");
    });

    it("returns 400 for invalid cron expression", async () => {
      const res = await callRoute("POST", "/automations", {
        body: { ...validBody, scheduleCron: "not-a-cron" },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(body.error).toContain("cron");
    });

    it("returns 400 for cron interval under 15 minutes", async () => {
      const res = await callRoute("POST", "/automations", {
        body: { ...validBody, scheduleCron: "*/5 * * * *" },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(body.error).toContain("15 minutes");
    });

    it("returns 400 for invalid timezone", async () => {
      const res = await callRoute("POST", "/automations", {
        body: { ...validBody, scheduleTz: "Not/A/Timezone" },
      });
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(body.error).toContain("timezone");
    });
  });

  describe("GET /automations/:id (get)", () => {
    it("returns automation by id", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("GET", "/automations/auto-1");
      expect(res.status).toBe(200);

      const body = await res.json<{ automation: typeof sampleRow }>();
      expect(body.automation.id).toBe("auto-1");
    });

    it("returns 404 when not found", async () => {
      mockStore.getById.mockResolvedValue(null);

      const res = await callRoute("GET", "/automations/nonexistent");
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /automations/:id (update)", () => {
    it.each([
      ["repository", { repositories: [] }, "repositories.use"],
      ["environment", { environmentIds: [] }, "environments.use"],
    ] as const)(
      "allows clearing a %s replacement without target-use permission",
      async (_target, body, permission) => {
        mockStore.getById.mockResolvedValue(sampleRow);

        const res = await callRoute("PUT", "/automations/auto-1", {
          body,
          permissions: PERMISSION_IDS.filter((candidate) => candidate !== permission),
        });

        expect(res.status).toBe(200);
        expect(mockBatch).toHaveBeenCalled();
      }
    );

    it.each([
      [
        "repository",
        { repositories: [{ repoOwner: "acme", repoName: "api" }] },
        "repositories.use",
      ],
      ["environment", { environmentIds: ["env_1"] }, "environments.use"],
    ] as const)(
      "requires target-use permission for a non-empty %s replacement",
      async (_target, body, permission) => {
        mockStore.getById.mockResolvedValue(sampleRow);

        const res = await callRoute("PUT", "/automations/auto-1", {
          body,
          permissions: PERMISSION_IDS.filter((candidate) => candidate !== permission),
        });

        expect(res.status).toBe(403);
        await expect(res.json()).resolves.toEqual({
          error: "Forbidden",
          code: "permission_required",
          permission,
        });
        expect(mockBatch).not.toHaveBeenCalled();
      }
    );

    it("updates automation fields", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("PUT", "/automations/auto-1", {
        body: { name: "Updated" },
      });
      expect(res.status).toBe(200);
      expect(mockStore.bindAutomationUpdate).toHaveBeenCalledWith(
        "auto-1",
        expect.objectContaining({ name: "Updated" })
      );
      expect(mockBatch).toHaveBeenCalledWith(
        expect.arrayContaining([{ sql: "update-automation" }])
      );
    });

    it("leaves provider pins unchanged when providerSelections is omitted", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("PUT", "/automations/auto-1", { body: { name: "Updated" } });

      expect(res.status).toBe(200);
      expect(mockProviderAuthStore.bindReplace).not.toHaveBeenCalled();
    });

    it.each([
      [
        "replaces",
        {
          openai: {
            mode: "provider_account" as const,
            accountId: "0123456789abcdef0123456789abcdef",
          },
        },
      ],
      ["clears", {}],
    ])(
      "%s provider pins when providerSelections is present",
      async (_label, providerSelections) => {
        mockStore.getById.mockResolvedValue(sampleRow);

        const res = await callRoute("PUT", "/automations/auto-1", {
          body: { providerSelections },
        });

        expect(res.status).toBe(200);
        expect(mockProviderAuthStore.bindReplace).toHaveBeenCalledWith(
          "auto-1",
          providerSelections,
          expect.any(Number)
        );
        expect(mockBatch).toHaveBeenCalledWith(
          expect.arrayContaining([{ sql: "replace-provider-auth" }])
        );
      }
    );

    it.each([{ triggerConfig: {} }, { triggerConfig: { conditions: null } }])(
      "rejects malformed trigger config before updating",
      async ({ triggerConfig }) => {
        mockStore.getById.mockResolvedValue({
          ...sampleRow,
          trigger_type: "webhook",
          schedule_cron: null,
        });

        const response = await callRoute("PUT", "/automations/auto-1", {
          body: { triggerConfig },
        });

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          error: expect.stringContaining("triggerConfig.conditions"),
        });
        expect(mockStore.bindAutomationUpdate).not.toHaveBeenCalled();
      }
    );

    it("validates trigger config shape before schedule automation semantics", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const response = await callRoute("PUT", "/automations/auto-1", {
        body: { triggerConfig: {} },
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringContaining("triggerConfig.conditions"),
      });
    });

    it("rejects an event type change that would leave incompatible conditions", async () => {
      mockStore.getById.mockResolvedValue({
        ...sampleRow,
        trigger_type: "github_event",
        schedule_cron: null,
        schedule_tz: null,
        event_type: "workflow_run.completed",
        trigger_config: JSON.stringify({
          conditions: [{ type: "workflow_name", operator: "eq", value: "CI" }],
        }),
      });

      const response = await callRoute("PUT", "/automations/auto-1", {
        body: { eventType: "pull_request.opened" },
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'Condition "workflow_name" does not apply to GitHub event pull_request.opened',
      });
      expect(mockStore.bindAutomationUpdate).not.toHaveBeenCalled();
    });

    it.each([null, "", "   "])("rejects an invalid explicit event type: %j", async (eventType) => {
      mockStore.getById.mockResolvedValue({
        ...sampleRow,
        trigger_type: "github_event",
        schedule_cron: null,
        schedule_tz: null,
        event_type: "workflow_run.completed",
      });

      const response = await callRoute("PUT", "/automations/auto-1", {
        body: { eventType },
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "eventType must be a non-empty string",
      });
      expect(mockStore.bindAutomationUpdate).not.toHaveBeenCalled();
    });

    it("rejects an unsupported explicit event type", async () => {
      mockStore.getById.mockResolvedValue({
        ...sampleRow,
        trigger_type: "github_event",
        schedule_cron: null,
        schedule_tz: null,
        event_type: "workflow_run.completed",
      });

      const response = await callRoute("PUT", "/automations/auto-1", {
        body: { eventType: "workflow_run.typo" },
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Unsupported eventType for github_event: workflow_run.typo",
      });
      expect(mockStore.bindAutomationUpdate).not.toHaveBeenCalled();
    });

    it("allows an unchanged legacy condition on an unrelated edit", async () => {
      const legacyTriggerConfig = {
        conditions: [{ type: "path_glob", operator: "any_match", value: ["src/**"] }],
      } as const;
      mockStore.getById.mockResolvedValue({
        ...sampleRow,
        trigger_type: "github_event",
        schedule_cron: null,
        schedule_tz: null,
        event_type: "pull_request.opened",
        trigger_config: JSON.stringify(legacyTriggerConfig),
      });

      const response = await callRoute("PUT", "/automations/auto-1", {
        body: { name: "Updated", triggerConfig: legacyTriggerConfig },
      });

      expect(response.status).toBe(200);
      expect(mockStore.bindAutomationUpdate).toHaveBeenCalledWith(
        "auto-1",
        expect.objectContaining({
          name: "Updated",
          trigger_config: JSON.stringify(legacyTriggerConfig),
        })
      );
    });

    it("allows resubmitting the same event type without a legacy trigger config", async () => {
      mockStore.getById.mockResolvedValue({
        ...sampleRow,
        trigger_type: "github_event",
        schedule_cron: null,
        schedule_tz: null,
        event_type: "pull_request.opened",
        trigger_config: JSON.stringify({
          conditions: [{ type: "path_glob", operator: "any_match", value: ["src/**"] }],
        }),
      });

      const response = await callRoute("PUT", "/automations/auto-1", {
        body: { eventType: "pull_request.opened" },
      });

      expect(response.status).toBe(200);
      expect(mockStore.bindAutomationUpdate).toHaveBeenCalledWith("auto-1", {
        event_type: "pull_request.opened",
      });
    });

    it("rejects modifying a grandfathered incompatible condition", async () => {
      mockStore.getById.mockResolvedValue({
        ...sampleRow,
        trigger_type: "github_event",
        schedule_cron: null,
        schedule_tz: null,
        event_type: "pull_request.opened",
        trigger_config: JSON.stringify({
          conditions: [{ type: "path_glob", operator: "any_match", value: ["src/**"] }],
        }),
      });

      const response = await callRoute("PUT", "/automations/auto-1", {
        body: {
          triggerConfig: {
            conditions: [{ type: "path_glob", operator: "any_match", value: ["packages/**"] }],
          },
        },
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'Condition "path_glob" does not apply to github triggers',
      });
      expect(mockStore.bindAutomationUpdate).not.toHaveBeenCalled();
    });

    it("rejects appending a duplicate grandfathered condition", async () => {
      const legacyCondition = {
        type: "path_glob",
        operator: "any_match",
        value: ["src/**"],
      } as const;
      mockStore.getById.mockResolvedValue({
        ...sampleRow,
        trigger_type: "github_event",
        schedule_cron: null,
        schedule_tz: null,
        event_type: "pull_request.opened",
        trigger_config: JSON.stringify({ conditions: [legacyCondition] }),
      });

      const response = await callRoute("PUT", "/automations/auto-1", {
        body: {
          triggerConfig: { conditions: [legacyCondition, legacyCondition] },
        },
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'Condition "path_glob" does not apply to github triggers',
      });
      expect(mockStore.bindAutomationUpdate).not.toHaveBeenCalled();
    });

    it("updates reasoning effort when valid for the selected model", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("PUT", "/automations/auto-1", {
        body: { reasoningEffort: "high" },
      });

      expect(res.status).toBe(200);
      expect(mockStore.bindAutomationUpdate).toHaveBeenCalledWith(
        "auto-1",
        expect.objectContaining({ reasoning_effort: "high" })
      );
    });

    it("accepts nullable reasoning effort in update payloads", async () => {
      mockStore.getById.mockResolvedValue({ ...sampleRow, reasoning_effort: "high" });

      const res = await callRoute("PUT", "/automations/auto-1", {
        body: { reasoningEffort: null },
      });

      expect(res.status).toBe(200);
      expect(mockStore.bindAutomationUpdate).toHaveBeenCalledWith(
        "auto-1",
        expect.objectContaining({ reasoning_effort: null })
      );
    });

    it("rejects malformed update payloads before persistence", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("PUT", "/automations/auto-1", {
        body: { reasoningEffort: 123 },
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "Invalid automation request" });
      expect(mockStore.bindAutomationUpdate).not.toHaveBeenCalled();
      expect(mockBatch).not.toHaveBeenCalled();
    });

    it("clears incompatible reasoning effort when model changes", async () => {
      mockStore.getById.mockResolvedValue({ ...sampleRow, reasoning_effort: "max" });

      const res = await callRoute("PUT", "/automations/auto-1", {
        body: { model: "openai/gpt-5.4" },
      });

      expect(res.status).toBe(200);
      expect(mockStore.bindAutomationUpdate).toHaveBeenCalledWith(
        "auto-1",
        expect.objectContaining({ model: "openai/gpt-5.4", reasoning_effort: null })
      );
    });

    it("replaces the environment selection", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("PUT", "/automations/auto-1", {
        body: { environmentIds: ["env_1"] },
      });

      expect(res.status).toBe(200);
      expect(mockEnvironmentStore.getById).toHaveBeenCalledWith("env_1");
      expect(mockStore.bindReplaceEnvironments).toHaveBeenCalledWith(
        "auto-1",
        ["env_1"],
        expect.any(Number)
      );
      expect(mockBatch).toHaveBeenCalledWith(
        expect.arrayContaining([{ sql: "replace-environments" }])
      );
    });

    it("clears the environment selection with an empty list", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("PUT", "/automations/auto-1", {
        body: { environmentIds: [] },
      });

      expect(res.status).toBe(200);
      expect(mockStore.bindReplaceEnvironments).toHaveBeenCalledWith(
        "auto-1",
        [],
        expect.any(Number)
      );
    });

    it("validates the combined count against the other side's existing rows", async () => {
      // A webhook automation with one existing repository row: adding an
      // environment makes it multi-target, which requires a schedule trigger.
      mockStore.getById.mockResolvedValue({
        ...sampleRow,
        trigger_type: "webhook",
        schedule_cron: null,
      });
      mockStore.getRepositoriesForAutomation.mockResolvedValue([
        { repo_owner: "acme", repo_name: "web-app" },
      ]);

      const res = await callRoute("PUT", "/automations/auto-1", {
        body: { environmentIds: ["env_1"] },
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Multi-target selections require a schedule trigger",
      });
    });

    it("rejects an unknown environment on update", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);
      mockEnvironmentStore.getById.mockResolvedValue(null);

      const res = await callRoute("PUT", "/automations/auto-1", {
        body: { environmentIds: ["env_missing"] },
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Environment not found: env_missing" });
    });

    it("clears repository context with an empty repositories list", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("PUT", "/automations/auto-1", {
        body: { repositories: [] },
      });

      expect(res.status).toBe(200);
      expect(mockStore.bindReplaceRepositories).toHaveBeenCalledWith(
        "auto-1",
        [],
        expect.any(Number)
      );
      expect(mockBatch).toHaveBeenCalledWith(
        expect.arrayContaining([{ sql: "replace-repositories" }])
      );
    });

    it("rejects clearing repository context on repo-scoped automations", async () => {
      mockStore.getById.mockResolvedValue({
        ...sampleRow,
        trigger_type: "github_event",
        event_type: "pull_request.opened",
        schedule_cron: null,
      });

      const res = await callRoute("PUT", "/automations/auto-1", {
        body: { repositories: [] },
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Repository-scoped triggers require exactly one repository",
      });
      expect(mockBatch).not.toHaveBeenCalled();
    });

    it("replaces repository context when repo fields are supplied", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("PUT", "/automations/auto-1", {
        body: { repositories: [{ repoOwner: "Acme", repoName: "Web-App" }] },
      });

      expect(res.status).toBe(200);
      expect(mockStore.bindReplaceRepositories).toHaveBeenCalledWith(
        "auto-1",
        [{ repo_owner: "acme", repo_name: "web-app", repo_id: 12345, base_branch: "main" }],
        expect.any(Number)
      );
    });

    it("resets the branch to the resolved default when the repository changes", async () => {
      // Existing automation tracks acme/web-app@main; retargeting must take the
      // NEW repo's default branch, never carry the previous row's branch over.
      mockStore.getById.mockResolvedValue(sampleRow);
      vi.mocked(resolveRepoOrError).mockResolvedValue({
        repoId: 777,
        repoOwner: "acme",
        repoName: "api",
        defaultBranch: "trunk",
      });

      const res = await callRoute("PUT", "/automations/auto-1", {
        body: { repositories: [{ repoOwner: "acme", repoName: "api" }] },
      });

      expect(res.status).toBe(200);
      expect(mockStore.bindReplaceRepositories).toHaveBeenCalledWith(
        "auto-1",
        [{ repo_owner: "acme", repo_name: "api", repo_id: 777, base_branch: "trunk" }],
        expect.any(Number)
      );
    });

    it("replaces the whole selection from the repositories list", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("PUT", "/automations/auto-1", {
        body: {
          repositories: [
            { repoOwner: "acme", repoName: "web-app" },
            { repoOwner: "acme", repoName: "api", baseBranch: "develop" },
          ],
        },
      });

      expect(res.status).toBe(200);
      expect(mockStore.bindReplaceRepositories).toHaveBeenCalledWith(
        "auto-1",
        [
          { repo_owner: "acme", repo_name: "web-app", repo_id: 12345, base_branch: "main" },
          { repo_owner: "acme", repo_name: "api", repo_id: 12345, base_branch: "develop" },
        ],
        expect.any(Number)
      );
    });

    it("applies repository-set edits without consulting active runs", async () => {
      // Snapshots on runs make edits safe mid-invocation — there is no
      // active-run guard on the repository selection.
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("PUT", "/automations/auto-1", {
        body: {
          repositories: [
            { repoOwner: "acme", repoName: "api" },
            { repoOwner: "acme", repoName: "cli" },
          ],
        },
      });

      expect(res.status).toBe(200);
      expect(mockStore.getActiveRunForAutomation).not.toHaveBeenCalled();
      expect(mockStore.bindReplaceRepositories).toHaveBeenCalledTimes(1);
    });

    it("returns 400 for invalid reasoning effort in update", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("PUT", "/automations/auto-1", {
        body: { model: "anthropic/claude-sonnet-4-6", reasoningEffort: "xhigh" },
      });

      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(body.error).toContain("reasoning");
    });

    it("returns 404 when automation not found", async () => {
      mockStore.getById.mockResolvedValue(null);

      const res = await callRoute("PUT", "/automations/missing", {
        body: { name: "Updated" },
      });
      expect(res.status).toBe(404);
    });

    it("returns 400 for invalid cron in update", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("PUT", "/automations/auto-1", {
        body: { scheduleCron: "bad" },
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for empty name in update", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("PUT", "/automations/auto-1", {
        body: { name: "" },
      });
      expect(res.status).toBe(400);
    });

    it("recomputes next_run_at when schedule changes", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      await callRoute("PUT", "/automations/auto-1", {
        body: { scheduleCron: "0 12 * * *" },
      });

      expect(mockStore.bindAutomationUpdate).toHaveBeenCalledWith(
        "auto-1",
        expect.objectContaining({
          schedule_cron: "0 12 * * *",
          next_run_at: expect.any(Number),
        })
      );
    });
  });

  describe("DELETE /automations/:id", () => {
    it("soft-deletes automation", async () => {
      const res = await callRoute("DELETE", "/automations/auto-1");
      expect(res.status).toBe(200);

      const body = await res.json<{ status: string }>();
      expect(body.status).toBe("deleted");
    });

    it("returns 404 when not found", async () => {
      mockBatch.mockResolvedValue([{ meta: { changes: 0 }, results: [] }]);

      const res = await callRoute("DELETE", "/automations/missing");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /automations/:id/pause", () => {
    it("pauses automation", async () => {
      mockStore.getById.mockResolvedValue({ ...sampleRow, enabled: 0 });

      const res = await callRoute("POST", "/automations/auto-1/pause");
      expect(res.status).toBe(200);
      expect(mockStore.bindPause).toHaveBeenCalledWith("auto-1");
    });

    it("returns 404 when not found", async () => {
      mockBatch.mockResolvedValue([{ meta: { changes: 0 }, results: [] }]);

      const res = await callRoute("POST", "/automations/missing/pause");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /automations/:id/resume", () => {
    it("resumes automation and recomputes next_run_at", async () => {
      mockStore.getById.mockResolvedValue({ ...sampleRow, enabled: 0 });

      const res = await callRoute("POST", "/automations/auto-1/resume");
      expect(res.status).toBe(200);
      expect(mockStore.bindResume).toHaveBeenCalledWith("auto-1", expect.any(Number));
    });

    it("returns 404 when not found", async () => {
      mockStore.getById.mockResolvedValue(null);

      const res = await callRoute("POST", "/automations/missing/resume");
      expect(res.status).toBe(404);
    });

    it("returns 400 when automation has no cron schedule", async () => {
      mockStore.getById.mockResolvedValue({
        ...sampleRow,
        schedule_cron: null,
      });

      const res = await callRoute("POST", "/automations/auto-1/resume");
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(body.error).toContain("no cron schedule");
    });
  });

  describe("POST /automations/:id/regenerate-key", () => {
    it.each([123, "  "])(
      "rejects malformed sentry secret payloads before persistence",
      async (sentryClientSecret) => {
        mockStore.getById.mockResolvedValue({ ...sampleRow, trigger_type: "sentry" });

        const res = await callRoute("POST", "/automations/auto-1/regenerate-key", {
          body: { sentryClientSecret },
        });

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: "sentryClientSecret is required" });
        expect(mockStore.update).not.toHaveBeenCalled();
      }
    );

    it("returns 404 when the key update affects no current automation", async () => {
      mockStore.getById.mockResolvedValue({ ...sampleRow, trigger_type: "webhook" });
      mockBatch.mockResolvedValue([{ meta: { changes: 0 }, results: [] }]);

      const res = await callRoute("POST", "/automations/auto-1/regenerate-key");

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: "Automation not found" });
    });
  });

  describe("POST /automations/:id/trigger", () => {
    it("triggers automation via the scheduler", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);
      mockStore.getActiveRunForAutomation.mockResolvedValue(null);
      const enrichment = {
        scmUserId: "123",
        scmLogin: "requester",
        accessTokenEncrypted: "encrypted-access",
      };
      mockResolveGitHubEnrichmentForRequest.mockResolvedValue(enrichment);

      const res = await callRoute("POST", "/automations/auto-1/trigger");
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({
        invocationId: "inv-1",
        runs: [{ id: "run-1" }],
      });
      expect(mockSchedulerTrigger).toHaveBeenCalledWith("auto-1", "user-1", enrichment);
    });

    it("returns 404 when automation not found", async () => {
      mockStore.getById.mockResolvedValue(null);

      const res = await callRoute("POST", "/automations/missing/trigger");
      expect(res.status).toBe(404);
    });

    it("returns 409 when the scheduler reports an active run", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      mockSchedulerTrigger.mockRejectedValue(new AutomationTriggerBlockedError());

      const res = await callRoute("POST", "/automations/auto-1/trigger");
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "A run is already active for this automation",
      });
    });

    it("returns 403 when the owner is unauthorized to execute", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);
      mockSchedulerTrigger.mockRejectedValue(new AutomationExecutionUnauthorizedError());

      const res = await callRoute("POST", "/automations/auto-1/trigger");

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Execution authorization required" });
    });

    it("returns 500 when the scheduler cannot launch the automation", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);
      mockSchedulerTrigger.mockRejectedValue(new Error("launch failed"));

      const res = await callRoute("POST", "/automations/auto-1/trigger");

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Failed to trigger automation" });
    });
  });

  describe("GET /automations/:id/invocations (list invocations)", () => {
    it("returns invocations for automation", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);
      mockStore.listInvocations.mockResolvedValue({
        invocations: [{ id: "inv-1", status: "completed", runs: [{ id: "run-1" }] }],
        total: 1,
      });

      const res = await callRoute("GET", "/automations/auto-1/invocations");
      expect(res.status).toBe(200);

      const body = await res.json<{ invocations: unknown[]; total: number }>();
      expect(body.invocations).toHaveLength(1);
      expect(body.total).toBe(1);
    });

    it("returns 404 when automation not found", async () => {
      mockStore.getById.mockResolvedValue(null);

      const res = await callRoute("GET", "/automations/missing/invocations");
      expect(res.status).toBe(404);
    });

    it("respects limit and offset params", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);
      mockStore.listInvocations.mockResolvedValue({ invocations: [], total: 0 });

      await callRoute("GET", "/automations/auto-1/invocations", {
        query: { limit: "5", offset: "10" },
      });

      expect(mockStore.listInvocations).toHaveBeenCalledWith("auto-1", {
        limit: 5,
        offset: 10,
      });
    });
  });

  describe("GET /automations/:id/runs/:runId (get run)", () => {
    it("returns a specific run", async () => {
      mockStore.getRunById.mockResolvedValue({ id: "run-1", status: "completed" });

      const res = await callRoute("GET", "/automations/auto-1/runs/run-1");
      expect(res.status).toBe(200);

      const body = await res.json<{ run: { id: string } }>();
      expect(body.run.id).toBe("run-1");
    });

    it("returns 404 when run not found", async () => {
      mockStore.getRunById.mockResolvedValue(null);

      const res = await callRoute("GET", "/automations/auto-1/runs/missing");
      expect(res.status).toBe(404);
    });
  });
});
