/**
 * Unit tests for automation CRUD route handlers.
 *
 * Tests run in Node (not workerd) with mocked AutomationStore and source
 * control. Handler functions are extracted from the exported automationRoutes
 * array and invoked directly, bypassing the auth middleware.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { automationRoutes } from "./automations";
import { resolveRepoOrError, type RequestContext } from "./shared";
import type { Env } from "../types";

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
  bindAutomationInsert: vi.fn(),
  bindAutomationUpdate: vi.fn(),
  bindRepositoryInserts: vi.fn(),
  bindReplaceRepositories: vi.fn(),
  listInvocations: vi.fn(),
  listRunsFlattenedForAutomation: vi.fn(),
};

/** Shared D1 batch spy — createEnv wires it as env.DB.batch. */
const mockBatch = vi.fn();

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

/** Find the handler for a given method + path from automationRoutes. */
function getHandler(method: string, path: string) {
  for (const route of automationRoutes) {
    if (route.method === method && route.pattern.test(path)) {
      const match = path.match(route.pattern)!;
      return { handler: route.handler, match };
    }
  }
  throw new Error(`No route found for ${method} ${path}`);
}

function createEnv(): Env {
  return {
    DB: { batch: mockBatch } as unknown as D1Database,
    SESSION: {} as DurableObjectNamespace,
    SCHEDULER: {
      idFromName: vi.fn().mockReturnValue("fake-id"),
      get: vi.fn().mockReturnValue({
        fetch: vi.fn().mockResolvedValue(Response.json({ run: { id: "run-1" } }, { status: 201 })),
      }),
    } as unknown as DurableObjectNamespace,
    DEPLOYMENT_NAME: "test",
    TOKEN_ENCRYPTION_KEY: "test-key",
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

async function callRoute(
  method: string,
  path: string,
  options?: { body?: unknown; query?: Record<string, string> }
): Promise<Response> {
  const { handler, match } = getHandler(method, path);
  const url = new URL(`https://test.local${path}`);
  if (options?.query) {
    for (const [k, v] of Object.entries(options.query)) {
      url.searchParams.set(k, v);
    }
  }
  const init: RequestInit = { method };
  if (options?.body) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(options.body);
  }
  return handler(new Request(url, init), createEnv(), match, createCtx());
}

// ─── Sample data ────────────────────────────────────────────────────────────

const now = Date.now();

const sampleRow = {
  id: "auto-1",
  name: "Daily sync",
  repo_owner: "acme",
  repo_name: "web-app",
  base_branch: "main",
  repo_id: 12345,
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
    mockStore.bindAutomationInsert.mockReturnValue({ sql: "insert-automation" });
    mockStore.bindAutomationUpdate.mockReturnValue({ sql: "update-automation" });
    mockStore.bindRepositoryInserts.mockReturnValue([{ sql: "insert-repositories" }]);
    mockStore.bindReplaceRepositories.mockReturnValue([{ sql: "replace-repositories" }]);
    mockBatch.mockResolvedValue([]);
    vi.mocked(resolveRepoOrError).mockResolvedValue({
      repoId: 12345,
      repoOwner: "acme",
      repoName: "web-app",
      defaultBranch: "main",
    });
  });

  describe("GET /automations (list)", () => {
    it("returns list of automations", async () => {
      mockStore.list.mockResolvedValue({
        automations: [sampleRow],
        total: 1,
      });

      const res = await callRoute("GET", "/automations");
      expect(res.status).toBe(200);

      const body = await res.json<{ automations: unknown[]; total: number }>();
      expect(body.automations).toHaveLength(1);
      expect(body.total).toBe(1);
    });

    it("passes filter params to store", async () => {
      mockStore.list.mockResolvedValue({ automations: [], total: 0 });

      await callRoute("GET", "/automations", {
        query: { repoOwner: "acme", repoName: "web-app" },
      });

      expect(mockStore.list).toHaveBeenCalledWith({
        repoOwner: "acme",
        repoName: "web-app",
      });
    });
  });

  describe("POST /automations (create)", () => {
    const validBody = {
      name: "Daily sync",
      repoOwner: "acme",
      repoName: "web-app",
      scheduleCron: "0 9 * * *",
      scheduleTz: "UTC",
      instructions: "Run tests",
    };

    it("creates automation with valid input", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("POST", "/automations", { body: validBody });
      expect(res.status).toBe(201);

      // Scalar sugar → one repository row plus the scalar mirror, persisted
      // in a single atomic batch.
      expect(mockStore.bindAutomationInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          repo_owner: "acme",
          repo_name: "web-app",
          repo_id: 12345,
          base_branch: "main",
        })
      );
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
      // Multi-repo selections have no scalar mirror.
      expect(mockStore.bindAutomationInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          repo_owner: null,
          repo_name: null,
          repo_id: null,
          base_branch: null,
        })
      );
    });

    it("rejects sending both repositories and the scalar repo fields", async () => {
      const res = await callRoute("POST", "/automations", {
        body: {
          ...validBody,
          repositories: [{ repoOwner: "acme", repoName: "web-app" }],
        },
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Provide either repositories or the repoOwner/repoName fields, not both",
      });
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
        error: "Multi-repository selections require a schedule trigger",
      });
    });

    it("creates repo-less automation without repo fields", async () => {
      const noRepoRow = {
        ...sampleRow,
        repo_owner: null,
        repo_name: null,
        repo_id: null,
        base_branch: null,
      };
      mockStore.getById.mockResolvedValue(noRepoRow);

      const res = await callRoute("POST", "/automations", {
        body: {
          name: "Incident sweep",
          scheduleCron: "0 9 * * *",
          scheduleTz: "UTC",
          instructions: "Check recent incidents and summarize.",
        },
      });

      expect(res.status).toBe(201);
      expect(mockStore.bindAutomationInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          repo_owner: null,
          repo_name: null,
          repo_id: null,
          base_branch: null,
        })
      );
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
        error: "repoOwner and repoName are required for repo-scoped triggers",
      });
    });

    it("rejects partial repository fields", async () => {
      const res = await callRoute("POST", "/automations", {
        body: {
          name: "Partial repo",
          repoOwner: "acme",
          scheduleCron: "0 9 * * *",
          scheduleTz: "UTC",
          instructions: "Run tests",
        },
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "repoOwner and repoName must be provided together",
      });
    });

    it("rejects baseBranch without repository context", async () => {
      const res = await callRoute("POST", "/automations", {
        body: {
          name: "Branch without repo",
          scheduleCron: "0 9 * * *",
          scheduleTz: "UTC",
          instructions: "Run without a repository.",
          baseBranch: "main",
        },
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "baseBranch requires repoOwner and repoName",
      });
      expect(mockBatch).not.toHaveBeenCalled();
    });

    it("resolves user_id when scmUserId is provided", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("POST", "/automations", {
        body: { ...validBody, scmUserId: "12345", scmLogin: "alice" },
      });

      expect(res.status).toBe(201);
      expect(mockUserStore.resolveOrCreateUser).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "github",
          providerUserId: "12345",
          providerLogin: "alice",
        })
      );
      expect(mockStore.bindAutomationInsert).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: "resolved-user-1" })
      );
    });

    it("creates automation with null user_id when scmUserId is missing", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("POST", "/automations", { body: validBody });

      expect(res.status).toBe(201);
      expect(mockUserStore.resolveOrCreateUser).not.toHaveBeenCalled();
      expect(mockStore.bindAutomationInsert).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: null })
      );
    });

    it("resolves user_id for a Google automation (auth* fields, no scmUserId)", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("POST", "/automations", {
        body: {
          ...validBody,
          authProvider: "google",
          authUserId: "google-sub-1",
          authEmail: "pm@corp.com",
          authName: "PM Person",
        },
      });

      expect(res.status).toBe(201);
      expect(mockUserStore.resolveOrCreateUser).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "google",
          providerUserId: "google-sub-1",
          providerEmail: "pm@corp.com",
        })
      );
      expect(mockStore.bindAutomationInsert).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: "resolved-user-1" })
      );
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

    it("returns 400 when repoOwner is missing", async () => {
      const res = await callRoute("POST", "/automations", {
        body: { ...validBody, repoOwner: "" },
      });
      expect(res.status).toBe(400);
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

    it("clears repository context when explicit null repo fields are supplied", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("PUT", "/automations/auto-1", {
        body: { repoOwner: null, repoName: null },
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
        body: { repoOwner: null, repoName: null },
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "repoOwner and repoName are required for repo-scoped triggers",
      });
      expect(mockBatch).not.toHaveBeenCalled();
    });

    it("rejects repository context updates with only one repo field", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("PUT", "/automations/auto-1", {
        body: { repoOwner: null },
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "repoOwner and repoName must be provided together",
      });
      expect(mockBatch).not.toHaveBeenCalled();
    });

    it("replaces repository context when repo fields are supplied", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("PUT", "/automations/auto-1", {
        body: { repoOwner: "Acme", repoName: "Web-App" },
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
        body: { repoOwner: "acme", repoName: "api" },
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

    it("applies baseBranch to the single selected repository", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);
      mockStore.getRepositoriesForAutomation.mockResolvedValue([
        {
          automation_id: "auto-1",
          repo_owner: "acme",
          repo_name: "web-app",
          repo_id: 12345,
          base_branch: "main",
          created_at: now,
          updated_at: now,
        },
      ]);

      const res = await callRoute("PUT", "/automations/auto-1", {
        body: { baseBranch: "release" },
      });

      expect(res.status).toBe(200);
      expect(mockStore.bindReplaceRepositories).toHaveBeenCalledWith(
        "auto-1",
        [{ repo_owner: "acme", repo_name: "web-app", repo_id: 12345, base_branch: "release" }],
        expect.any(Number)
      );
    });

    it("rejects a bare baseBranch on multi-repository automations", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);
      mockStore.getRepositoriesForAutomation.mockResolvedValue([
        {
          automation_id: "auto-1",
          repo_owner: "acme",
          repo_name: "web-app",
          repo_id: 12345,
          base_branch: "main",
          created_at: now,
          updated_at: now,
        },
        {
          automation_id: "auto-1",
          repo_owner: "acme",
          repo_name: "api",
          repo_id: 777,
          base_branch: "main",
          created_at: now,
          updated_at: now,
        },
      ]);

      const res = await callRoute("PUT", "/automations/auto-1", {
        body: { baseBranch: "release" },
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error:
          "baseBranch applies per repository on multi-repository automations; resend repositories",
      });
      expect(mockBatch).not.toHaveBeenCalled();
    });

    it("rejects branch updates without repository context", async () => {
      mockStore.getById.mockResolvedValue({
        ...sampleRow,
        repo_owner: null,
        repo_name: null,
        repo_id: null,
        base_branch: null,
      });

      const res = await callRoute("PUT", "/automations/auto-1", {
        body: { baseBranch: "main" },
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: "baseBranch requires repoOwner and repoName",
      });
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
      mockStore.softDelete.mockResolvedValue(true);

      const res = await callRoute("DELETE", "/automations/auto-1");
      expect(res.status).toBe(200);

      const body = await res.json<{ status: string }>();
      expect(body.status).toBe("deleted");
    });

    it("returns 404 when not found", async () => {
      mockStore.softDelete.mockResolvedValue(false);

      const res = await callRoute("DELETE", "/automations/missing");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /automations/:id/pause", () => {
    it("pauses automation", async () => {
      mockStore.pause.mockResolvedValue(true);
      mockStore.getById.mockResolvedValue({ ...sampleRow, enabled: 0 });

      const res = await callRoute("POST", "/automations/auto-1/pause");
      expect(res.status).toBe(200);
      expect(mockStore.pause).toHaveBeenCalledWith("auto-1");
    });

    it("returns 404 when not found", async () => {
      mockStore.pause.mockResolvedValue(false);

      const res = await callRoute("POST", "/automations/missing/pause");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /automations/:id/resume", () => {
    it("resumes automation and recomputes next_run_at", async () => {
      mockStore.getById.mockResolvedValue({ ...sampleRow, enabled: 0 });
      mockStore.resume.mockResolvedValue(true);

      const res = await callRoute("POST", "/automations/auto-1/resume");
      expect(res.status).toBe(200);
      expect(mockStore.resume).toHaveBeenCalledWith("auto-1", expect.any(Number));
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

  describe("POST /automations/:id/trigger", () => {
    it("triggers automation via SchedulerDO", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);
      mockStore.getActiveRunForAutomation.mockResolvedValue(null);

      const res = await callRoute("POST", "/automations/auto-1/trigger");
      expect(res.status).toBe(201);
    });

    it("returns 404 when automation not found", async () => {
      mockStore.getById.mockResolvedValue(null);

      const res = await callRoute("POST", "/automations/missing/trigger");
      expect(res.status).toBe(404);
    });

    it("returns 409 when SchedulerDO reports active run", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      // Override the SCHEDULER stub to return 409 (concurrency check lives in the DO)
      const env = createEnv();
      (env.SCHEDULER!.get as ReturnType<typeof vi.fn>).mockReturnValue({
        fetch: vi
          .fn()
          .mockResolvedValue(Response.json({ error: "concurrent_run_active" }, { status: 409 })),
      });

      const { handler, match } = getHandler("POST", "/automations/auto-1/trigger");
      const request = new Request("https://test.local/automations/auto-1/trigger", {
        method: "POST",
      });
      const res = await handler(request, env, match, createCtx());
      expect(res.status).toBe(409);
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

  describe("GET /automations/:id/runs (deprecated flattened alias)", () => {
    it("returns flattened runs for automation", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);
      mockStore.listRunsFlattenedForAutomation.mockResolvedValue({
        runs: [{ id: "run-1", status: "completed" }],
        total: 1,
      });

      const res = await callRoute("GET", "/automations/auto-1/runs");
      expect(res.status).toBe(200);

      const body = await res.json<{ runs: unknown[]; total: number }>();
      expect(body.runs).toHaveLength(1);
      expect(body.total).toBe(1);
    });

    it("returns 404 when automation not found", async () => {
      mockStore.getById.mockResolvedValue(null);

      const res = await callRoute("GET", "/automations/missing/runs");
      expect(res.status).toBe(404);
    });

    it("respects limit and offset params", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);
      mockStore.listRunsFlattenedForAutomation.mockResolvedValue({ runs: [], total: 0 });

      await callRoute("GET", "/automations/auto-1/runs", {
        query: { limit: "5", offset: "10" },
      });

      expect(mockStore.listRunsFlattenedForAutomation).toHaveBeenCalledWith("auto-1", {
        limit: 5,
        offset: 10,
      });
    });

    it("caps limit at 100", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);
      mockStore.listRunsFlattenedForAutomation.mockResolvedValue({ runs: [], total: 0 });

      await callRoute("GET", "/automations/auto-1/runs", {
        query: { limit: "999" },
      });

      expect(mockStore.listRunsFlattenedForAutomation).toHaveBeenCalledWith("auto-1", {
        limit: 100,
        offset: 0,
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
