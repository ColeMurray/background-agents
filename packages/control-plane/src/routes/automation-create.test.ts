/**
 * Unit tests for the automation create route.
 *
 * Tests run in Node (not workerd) with mocked stores and source control.
 * Requests dispatch through the production module, so admission (including
 * the automation ownership requirement) runs; authentication is mocked to
 * supply the principal.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import { HttpError, resolveRepoOrError } from "./shared";
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
  SLACK_BOT_PRINCIPAL,
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

describe("automation create route", () => {
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

      const res = await callRoute("POST", "/automations", {
        body: {
          ...validBody,
          repositories: [
            { repoOwner: "acme", repoName: "web-app" },
            { repoOwner: "acme", repoName: "api" },
          ],
        },
      });

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({
        error: "Repository is not installed for the GitHub App",
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

      const res = await callRoute("POST", "/automations", {
        body: {
          ...validBody,
          repositories: [
            { repoOwner: "acme", repoName: "first" },
            { repoOwner: "acme", repoName: "second" },
          ],
        },
      });

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: "failed first" });
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

    it("refuses a bot actor at admission before any identity is resolved", async () => {
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

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({
        error: "Forbidden",
        code: "service_capability_required",
      });
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
});
