import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSION_IDS, type PermissionId } from "@open-inspect/shared/rbac";
import type * as AuthenticateModule from "../auth/authenticate";
import type * as SourceControlModule from "../source-control";
import {
  EnvironmentStore,
  type EnvironmentRepositoryRow,
  type EnvironmentRow,
} from "../db/environments";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import { TeamStore } from "../db/teams";
import { scheduleImageBuildOnSave } from "../image-builds/save-hooks";
import {
  authorizationDatabase,
  createTestEnv,
  createTestRequestHandler,
  TEST_BACKGROUND_TASK_CONTEXT,
} from "../router.test-support";
import { environmentRoutes } from "./environments";

const scmProvider = vi.hoisted(() => ({ checkRepositoryAccess: vi.fn() }));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: async (request: Request) => ({
    principal: { kind: "user", userId: "user-1" },
    request,
  }),
}));

vi.mock("../source-control", async (importOriginal) => ({
  ...(await importOriginal<typeof SourceControlModule>()),
  createSourceControlProviderFromEnv: vi.fn(() => scmProvider),
}));

vi.mock("../image-builds/save-hooks", () => ({ scheduleImageBuildOnSave: vi.fn() }));

const handleRequest = createTestRequestHandler([environmentRoutes]);
const existing: EnvironmentRow = {
  id: "env_1",
  owner_team_id: "team_alpha",
  name: "Alpha",
  description: null,
  prebuild_enabled: 1,
  channel_associations: null,
  created_at: 1,
  updated_at: 1,
};
const repositories = [{ repoOwner: "legacy/group", repoName: "old-app" }];
const existingRepositories: EnvironmentRepositoryRow[] = [
  {
    environment_id: "env_1",
    position: 0,
    repo_owner: "legacy/group",
    repo_name: "old-app",
    repo_id: 6,
    base_branch: "release",
  },
];
const batch = vi.fn();

async function callRoute(
  method: "POST" | "PUT",
  permissions: readonly PermissionId[] = PERMISSION_IDS,
  body: object = { name: "Alpha", repositories, prebuildEnabled: true }
) {
  return handleRequest(
    new Request(`https://test.local/environments${method === "PUT" ? "/env_1" : ""}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    createTestEnv({ DB: authorizationDatabase({ permissions, batch }) }),
    TEST_BACKGROUND_TASK_CONTEXT
  );
}

describe("environment target denials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    batch.mockResolvedValue([]);
    vi.spyOn(TeamStore.prototype, "isActive").mockResolvedValue(true);
    vi.spyOn(EnvironmentStore.prototype, "getByName").mockResolvedValue(null);
    vi.spyOn(EnvironmentStore.prototype, "getById").mockResolvedValue(existing);
    vi.spyOn(EnvironmentStore.prototype, "getRepositoriesForEnvironment").mockResolvedValue(
      existingRepositories
    );
    scmProvider.checkRepositoryAccess.mockResolvedValue({
      repoId: 7,
      repoOwner: "canonical/group",
      repoName: "app",
      defaultBranch: "main",
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(["POST", "PUT"] as const)(
    "denies %s repository selection before SCM lookup or writes",
    async (method) => {
      const create = vi.spyOn(EnvironmentStore.prototype, "create");
      const update = vi.spyOn(EnvironmentStore.prototype, "update");
      const grants = vi.spyOn(TeamRepositoryGrantStore.prototype, "listForTeam");

      const response = await callRoute(
        method,
        PERMISSION_IDS.filter((permission) => permission !== "repositories.use")
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "Forbidden",
        code: "permission_required",
        permission: "repositories.use",
      });
      expect(scmProvider.checkRepositoryAccess).not.toHaveBeenCalled();
      expect(grants).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(batch).not.toHaveBeenCalled();
      expect(scheduleImageBuildOnSave).not.toHaveBeenCalled();
    }
  );

  it("denies updates using the persisted owner team and resolved repository identity", async () => {
    const update = vi.spyOn(EnvironmentStore.prototype, "update");
    const covers = vi.spyOn(TeamRepositoryGrantStore.prototype, "covers").mockResolvedValue(false);
    vi.spyOn(TeamRepositoryGrantStore.prototype, "listForTeam").mockResolvedValue([]);

    const response = await callRoute("PUT");

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Target team lacks repository grant",
      code: "target_team_missing_grant",
      repository: "canonical/group/app",
    });
    expect(covers).toHaveBeenCalledWith("team_alpha", [7]);
    expect(update).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
    expect(scheduleImageBuildOnSave).not.toHaveBeenCalled();
  });

  it.each([
    { change: "enabling prebuilds", prebuildEnabled: 0, body: { prebuildEnabled: true } },
    { change: "changing metadata", prebuildEnabled: 1, body: { description: "Updated" } },
  ])("denies $change without replacing repositories after grant revocation", async (testCase) => {
    vi.mocked(EnvironmentStore.prototype.getById).mockResolvedValue({
      ...existing,
      prebuild_enabled: testCase.prebuildEnabled,
    });
    const update = vi.spyOn(EnvironmentStore.prototype, "update");
    const covers = vi.spyOn(TeamRepositoryGrantStore.prototype, "covers");
    vi.spyOn(TeamRepositoryGrantStore.prototype, "listForTeam").mockResolvedValue([]);

    const response = await callRoute("PUT", ["environments.manage"], testCase.body);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Target team lacks repository grant",
      code: "target_team_missing_grant",
      repository: "canonical/group/app",
    });
    expect(scmProvider.checkRepositoryAccess).toHaveBeenCalledOnce();
    expect(scmProvider.checkRepositoryAccess).toHaveBeenCalledWith({
      owner: "legacy/group",
      name: "old-app",
    });
    expect(covers).toHaveBeenCalledWith("team_alpha", [7]);
    expect(update).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
    expect(scheduleImageBuildOnSave).not.toHaveBeenCalled();
  });

  it("checks every unchanged member when a later repository's grant is revoked", async () => {
    vi.mocked(EnvironmentStore.prototype.getRepositoriesForEnvironment).mockResolvedValue([
      ...existingRepositories,
      {
        environment_id: "env_1",
        position: 1,
        repo_owner: "legacy/group",
        repo_name: "old-api",
        repo_id: 8,
        base_branch: "main",
      },
    ]);
    scmProvider.checkRepositoryAccess.mockResolvedValueOnce({
      repoId: 7,
      repoOwner: "canonical/group",
      repoName: "app",
      defaultBranch: "main",
    });
    scmProvider.checkRepositoryAccess.mockResolvedValueOnce({
      repoId: 8,
      repoOwner: "canonical/group",
      repoName: "api",
      defaultBranch: "main",
    });
    vi.spyOn(TeamRepositoryGrantStore.prototype, "listForTeam").mockResolvedValue([
      { grant_kind: "repository", repo_external_id: 7 },
    ]);
    const covers = vi.spyOn(TeamRepositoryGrantStore.prototype, "covers");
    const update = vi.spyOn(EnvironmentStore.prototype, "update");

    const response = await callRoute("PUT", ["environments.manage"], { description: "Updated" });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Target team lacks repository grant",
      code: "target_team_missing_grant",
      repository: "canonical/group/api",
    });
    expect(scmProvider.checkRepositoryAccess).toHaveBeenCalledTimes(2);
    expect(covers).toHaveBeenCalledWith("team_alpha", [7, 8]);
    expect(update).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
    expect(scheduleImageBuildOnSave).not.toHaveBeenCalled();
  });

  it("does not authorize a recreated unchanged repository using its stale persisted ID", async () => {
    vi.spyOn(TeamRepositoryGrantStore.prototype, "listForTeam").mockResolvedValue([
      { grant_kind: "repository", repo_external_id: 6 },
    ]);
    const covers = vi.spyOn(TeamRepositoryGrantStore.prototype, "covers");
    const update = vi.spyOn(EnvironmentStore.prototype, "update");

    const response = await callRoute("PUT", ["environments.manage"], { description: "Updated" });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Target team lacks repository grant",
      code: "target_team_missing_grant",
      repository: "canonical/group/app",
    });
    expect(covers).toHaveBeenCalledWith("team_alpha", [7]);
    expect(update).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
    expect(scheduleImageBuildOnSave).not.toHaveBeenCalled();
  });

  it("allows granted unchanged members without repositories.use or replacing them", async () => {
    vi.spyOn(TeamRepositoryGrantStore.prototype, "listForTeam").mockResolvedValue([
      { grant_kind: "repository", repo_external_id: 7 },
    ]);
    const covers = vi.spyOn(TeamRepositoryGrantStore.prototype, "covers");
    const update = vi.spyOn(EnvironmentStore.prototype, "update");

    const response = await callRoute("PUT", ["environments.manage"], { description: "Updated" });

    expect(response.status).toBe(200);
    expect(covers).toHaveBeenCalledWith("team_alpha", [7]);
    expect(scmProvider.checkRepositoryAccess).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith("env_1", { description: "Updated" }, undefined);
    expect(batch).toHaveBeenCalledOnce();
    expect(scheduleImageBuildOnSave).toHaveBeenCalledOnce();
  });

  it("allows disabling prebuilds after revocation without checking unchanged members", async () => {
    vi.mocked(EnvironmentStore.prototype.getById)
      .mockResolvedValueOnce(existing)
      .mockResolvedValue({ ...existing, prebuild_enabled: 0 });
    const grants = vi
      .spyOn(TeamRepositoryGrantStore.prototype, "listForTeam")
      .mockResolvedValue([]);
    const update = vi.spyOn(EnvironmentStore.prototype, "update");

    const response = await callRoute("PUT", ["environments.manage"], { prebuildEnabled: false });

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith("env_1", { prebuild_enabled: 0 }, undefined);
    expect(batch).toHaveBeenCalledOnce();
    expect(scmProvider.checkRepositoryAccess).not.toHaveBeenCalled();
    expect(grants).not.toHaveBeenCalled();
    expect(scheduleImageBuildOnSave).not.toHaveBeenCalled();
  });

  it.each([
    { change: "enabling prebuilds", prebuildEnabled: 0, body: { prebuildEnabled: true } },
    { change: "changing metadata", prebuildEnabled: 1, body: { description: "Updated" } },
  ])("preserves unowned workspace behavior when $change", async (testCase) => {
    vi.mocked(EnvironmentStore.prototype.getById)
      .mockResolvedValueOnce({
        ...existing,
        owner_team_id: null,
        prebuild_enabled: testCase.prebuildEnabled,
      })
      .mockResolvedValue({ ...existing, owner_team_id: null });
    const grants = vi
      .spyOn(TeamRepositoryGrantStore.prototype, "listForTeam")
      .mockResolvedValue([]);
    const update = vi.spyOn(EnvironmentStore.prototype, "update");

    const response = await callRoute("PUT", ["environments.manage"], testCase.body);

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0]?.[2]).toBeUndefined();
    expect(batch).toHaveBeenCalledOnce();
    expect(scmProvider.checkRepositoryAccess).not.toHaveBeenCalled();
    expect(grants).not.toHaveBeenCalled();
    expect(scheduleImageBuildOnSave).toHaveBeenCalledOnce();
  });

  it("does not re-resolve or re-authorize replacement repositories before scheduling", async () => {
    vi.spyOn(TeamRepositoryGrantStore.prototype, "listForTeam").mockResolvedValue([
      { grant_kind: "repository", repo_external_id: 7 },
    ]);
    const covers = vi.spyOn(TeamRepositoryGrantStore.prototype, "covers");

    const response = await callRoute("PUT");

    expect(response.status).toBe(200);
    expect(scmProvider.checkRepositoryAccess).toHaveBeenCalledOnce();
    expect(covers).toHaveBeenCalledOnce();
    expect(covers).toHaveBeenCalledWith("team_alpha", [7]);
    expect(batch).toHaveBeenCalledOnce();
    expect(scheduleImageBuildOnSave).toHaveBeenCalledOnce();
  });
});
