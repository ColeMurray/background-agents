import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorizationDatabase,
  createTestEnv,
  fakeSessionRuntimeDispatch,
  handleRequest,
  signedServiceRequest,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "./router.test-support";
import { createRequestMetrics } from "./db/instrumented-sql-database";
import { SessionIndexStore } from "./db/session-index";
import { TeamRepositoryGrantStore } from "./db/team-repository-grants";
import { TeamStore } from "./db/teams";
import { handleSpawnChild } from "./routes/session-child-spawn";
import { withSessionRuntime } from "./routes/session-route";
import { HttpError, resolveRepoOrError } from "./routes/shared";
import type * as SharedRoutes from "./routes/shared";
import * as integrationSettings from "./session/integration-settings-resolution";
import type { SpawnContext } from "./session/spawn-context";
import type { Env } from "./types";

vi.mock("./db/user-store", () => ({
  UserStore: vi.fn().mockImplementation(function () {
    return { getIdentity: async () => ({ userId: "canonical-user-123" }) };
  }),
}));

vi.mock("./routes/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof SharedRoutes>();
  return { ...actual, resolveRepoOrError: vi.fn() };
});

describe("handleSpawnChild repository grants", () => {
  const parentId = "parent-session-1";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(TeamStore.prototype, "isActive").mockResolvedValue(true);
    vi.spyOn(SessionIndexStore.prototype, "getSpawnDepth").mockResolvedValue(0);
    vi.spyOn(SessionIndexStore.prototype, "countTotalChildren").mockResolvedValue(0);
    vi.spyOn(integrationSettings, "resolveSandboxSettings").mockResolvedValue({});
    vi.mocked(resolveRepoOrError).mockResolvedValue({
      repoId: 12345,
      repoOwner: "acme",
      repoName: "web-app",
      defaultBranch: "main",
    });
  });
  afterEach(() => vi.restoreAllMocks());

  function makeGrantFixture(
    repoId = 12345,
    environmentId: string | null = null,
    hasRepository = true
  ) {
    const spawnContext: SpawnContext = {
      repoOwner: hasRepository ? "acme" : null,
      repoName: hasRepository ? "web-app" : null,
      repoId: hasRepository ? repoId : null,
      harness: "opencode",
      model: "anthropic/claude-sonnet-4-6",
      reasoningEffort: null,
      sandboxTimeoutMs: 14_400_000,
      baseBranch: "main",
      promptAuthor: {
        userId: "user-1",
        canonicalUserId: "canonical-user-123",
        scmUserId: "12345",
        scmLogin: "acmedev",
        scmName: "Acme Dev",
        scmEmail: "dev@acme.test",
      },
    };
    vi.spyOn(SessionIndexStore.prototype, "get").mockResolvedValue({
      id: parentId,
      title: null,
      userId: null,
      repoOwner: spawnContext.repoOwner,
      repoName: spawnContext.repoName,
      model: spawnContext.model,
      reasoningEffort: spawnContext.reasoningEffort,
      baseBranch: spawnContext.baseBranch,
      status: "active",
      ownerTeamId: "team_alpha",
      visibility: "workspace",
      environmentId,
      createdAt: 1,
      updatedAt: 1,
    });
    const store = {
      acquireChildAdmissionLease: vi
        .spyOn(SessionIndexStore.prototype, "acquireChildAdmissionLease")
        .mockResolvedValue(null),
      create: vi.spyOn(SessionIndexStore.prototype, "create").mockResolvedValue(undefined),
    };
    const childStub = {
      fetch: vi.fn<(request: Request) => Promise<Response>>(),
    };
    const env = createTestEnv({
      ...TEST_SERVICE_SECRETS,
      SCM_PROVIDER: "github",
      DB: authorizationDatabase({
        userId: "canonical-user-123",
        permissions: [
          "sessions.create",
          "repositories.use",
          "environments.use",
          "sessions.collaborate",
        ],
      }),
      SESSION: fakeSessionRuntimeDispatch(async (request, sessionId) =>
        sessionId === parentId ? Response.json(spawnContext) : childStub.fetch(request)
      ),
    });
    return { store, env, childStub };
  }

  async function makeRequest(env: Env): Promise<Response> {
    return handleRequest(
      await signedServiceRequest(`https://test.local/sessions/${parentId}/children`, {
        method: "POST",
        body: JSON.stringify({ title: "Child task", prompt: "Do the thing" }),
        service: "linear-bot",
        actor: "linear:U1",
      }),
      env,
      TEST_BACKGROUND_TASK_CONTEXT
    );
  }

  it("denies a child whose inherited repository is not granted to its parent team", async () => {
    const { store, env, childStub } = makeGrantFixture();
    vi.spyOn(TeamRepositoryGrantStore.prototype, "listForTeam").mockResolvedValue([]);

    const response = await makeRequest(env);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "target_team_missing_grant",
      repository: "acme/web-app",
    });
    expect(store.acquireChildAdmissionLease).not.toHaveBeenCalled();
    expect(store.create).not.toHaveBeenCalled();
    expect(childStub.fetch).not.toHaveBeenCalled();
  });

  it.each(["service", "sandbox"] as const)(
    "rejects a repo-less %s child after the parent team is archived",
    async (principal) => {
      const { store, env, childStub } = makeGrantFixture(12345, null, false);
      vi.mocked(TeamStore.prototype.isActive).mockResolvedValue(false);
      const grants = vi.spyOn(TeamRepositoryGrantStore.prototype, "listForTeam");
      const response =
        principal === "service"
          ? await makeRequest(env)
          : await handleSpawnChild(
              new Request(`https://test.local/sessions/${parentId}/children`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title: "Child", prompt: "Do the thing" }),
              }),
              env,
              { id: parentId },
              withSessionRuntime(env, {
                request_id: "request-1",
                trace_id: "trace-1",
                metrics: createRequestMetrics(),
                executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
                db: env.DB,
                principal: { kind: "sandbox", sessionId: parentId },
              })
            );
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ code: "team_not_active" });
      expect(resolveRepoOrError).not.toHaveBeenCalled();
      expect(grants).not.toHaveBeenCalled();
      expect(store.acquireChildAdmissionLease).not.toHaveBeenCalled();
      expect(store.create).not.toHaveBeenCalled();
      expect(childStub.fetch).not.toHaveBeenCalled();
    }
  );

  it("checks sandbox child grants with the current SCM ID instead of a stale inherited ID", async () => {
    const { store, env: fixture, childStub } = makeGrantFixture(999, "env_parent");
    const covers = vi
      .spyOn(TeamRepositoryGrantStore.prototype, "covers")
      .mockImplementation(async (_teamId, ids) => ids.every((id) => id === 999));
    vi.spyOn(TeamRepositoryGrantStore.prototype, "listForTeam").mockResolvedValue([]);
    const env = createTestEnv({ SESSION: fixture.SESSION });
    const ctx = withSessionRuntime(env, {
      request_id: "request-1",
      trace_id: "trace-1",
      metrics: createRequestMetrics(),
      executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
      db: env.DB,
      principal: { kind: "sandbox", sessionId: parentId },
    });

    const response = await handleSpawnChild(
      new Request(`https://test.local/sessions/${parentId}/children`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Child", prompt: "Do the thing" }),
      }),
      env,
      { id: parentId },
      ctx
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "target_team_missing_grant" });
    expect(resolveRepoOrError).toHaveBeenCalledWith(env, "acme", "web-app", ctx, expect.anything());
    expect(covers).toHaveBeenCalledWith("team_alpha", [12345]);
    expect(store.acquireChildAdmissionLease).not.toHaveBeenCalled();
    expect(store.create).not.toHaveBeenCalled();
    expect(childStub.fetch).not.toHaveBeenCalled();
  });

  it("does not fall back to an inherited ID when SCM resolution fails for a team child", async () => {
    const { store, env, childStub } = makeGrantFixture();
    vi.mocked(resolveRepoOrError).mockRejectedValue(new HttpError("Repository not installed", 404));
    const grants = vi.spyOn(TeamRepositoryGrantStore.prototype, "listForTeam");

    const response = await makeRequest(env);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "Repository not installed" });
    expect(grants).not.toHaveBeenCalled();
    expect(store.acquireChildAdmissionLease).not.toHaveBeenCalled();
    expect(store.create).not.toHaveBeenCalled();
    expect(childStub.fetch).not.toHaveBeenCalled();
  });
});
