/**
 * Unit tests for the automation read, update, and delete routes.
 *
 * Tests run in Node (not workerd) with mocked stores and source control.
 * Requests dispatch through the production module, so admission (including
 * the automation ownership requirement) runs; authentication is mocked to
 * supply the principal.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import { resolveRepoOrError } from "./shared";
import { PERMISSION_IDS } from "@open-inspect/shared/rbac";
import { createTestRequestHandler } from "../router.test-support";
import { automationRoutes } from "./automations";
import {
  mocks,
  mockStore,
  mockProviderAuthStore,
  mockProviderAccountStore,
  mockUserStore,
  mockEnvironmentStore,
  mockBatch,
  mockProviderAdapterGet,
  mockResolveGitHubCredentialAuthority,
  mockResolveGitHubEnrichmentForRequest,
  sampleRow,
  applyMockDefaults,
  automationRequest,
} from "./automations.test-support";

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: (...args: Parameters<typeof mocks.authenticate>) => mocks.authenticate(...args),
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

vi.mock("../db/automation-model-provider-auth", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    AutomationModelProviderAuthStore: vi.fn().mockImplementation(function () {
      return mockProviderAuthStore;
    }),
  };
});

vi.mock("../db/model-provider-accounts", () => ({
  ModelProviderAccountStore: vi.fn().mockImplementation(function () {
    return mockProviderAccountStore;
  }),
}));

vi.mock("../db/user-store", () => ({
  UserStore: vi.fn().mockImplementation(function () {
    return mockUserStore;
  }),
}));

vi.mock("../db/environments", () => ({
  EnvironmentStore: vi.fn().mockImplementation(function () {
    return mockEnvironmentStore;
  }),
}));

vi.mock("../auth/model-provider-account-default-adapters", () => ({
  modelProviderAccountAdapterRegistry: {
    get: (...args: unknown[]) => mockProviderAdapterGet(...args),
  },
}));

vi.mock("../source-control/github-credential-authority", () => ({
  resolveGitHubCredentialAuthority: (...args: unknown[]) =>
    mockResolveGitHubCredentialAuthority(...args),
}));

vi.mock("../session/identity", () => ({
  resolveGitHubEnrichmentForRequest: (...args: unknown[]) =>
    mockResolveGitHubEnrichmentForRequest(...args),
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

const callRoute = automationRequest(createTestRequestHandler([automationRoutes]));

describe("automation read, update, and delete routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyMockDefaults();
    vi.mocked(resolveRepoOrError).mockResolvedValue({
      repoId: 12345,
      repoOwner: "acme",
      repoName: "web-app",
      defaultBranch: "main",
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
});
