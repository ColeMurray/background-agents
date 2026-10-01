import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSION_IDS, type PermissionId } from "@open-inspect/shared/rbac";
import type * as AuthenticateModule from "../auth/authenticate";
import type * as SourceControlModule from "../source-control";
import { EnvironmentStore, type EnvironmentRow } from "../db/environments";
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
const batch = vi.fn();

async function callRoute(
  method: "POST" | "PUT",
  permissions: readonly PermissionId[] = PERMISSION_IDS
) {
  return handleRequest(
    new Request(`https://test.local/environments${method === "PUT" ? "/env_1" : ""}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alpha", repositories, prebuildEnabled: true }),
    }),
    createTestEnv({ DB: authorizationDatabase({ permissions, batch }) }),
    TEST_BACKGROUND_TASK_CONTEXT
  );
}

describe("environment target denials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(TeamStore.prototype, "isActive").mockResolvedValue(true);
    vi.spyOn(EnvironmentStore.prototype, "getByName").mockResolvedValue(null);
    vi.spyOn(EnvironmentStore.prototype, "getById").mockResolvedValue(existing);
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
});
