import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import type * as ImageBuildSaveHooksModule from "../image-builds/save-hooks";
import { EnvironmentStore, type EnvironmentRow } from "../db/environments";
import { TeamMembershipStore } from "../db/team-memberships";
import { TeamSecretsStore } from "../db/team-secrets";
import { TeamStore } from "../db/teams";
import {
  createTestEnv,
  createTestRequestHandler,
  ownerAuthorizationDatabase,
  TEST_BACKGROUND_TASK_CONTEXT,
} from "../router.test-support";
import { teamSecretsRoutes } from "./team-secrets";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  scheduleImageBuildOnSave: vi.fn(),
}));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

vi.mock("../image-builds/save-hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof ImageBuildSaveHooksModule>()),
  scheduleImageBuildOnSave: mocks.scheduleImageBuildOnSave,
}));

const handleRequest = createTestRequestHandler([teamSecretsRoutes]);
const teamId = "team-1";

function environment(
  id: string,
  ownerTeamId: string | null,
  prebuildEnabled: number
): EnvironmentRow {
  return {
    id,
    owner_team_id: ownerTeamId,
    prebuild_enabled: prebuildEnabled,
    name: id,
    description: null,
    channel_associations: null,
    created_at: 1,
    updated_at: 1,
  };
}

function request(
  method: "PUT" | "DELETE",
  secrets: Record<string, string> = { TOKEN: "replacement" }
) {
  return handleRequest(
    new Request(
      `https://test.local/teams/${teamId}/secrets${method === "DELETE" ? "/token" : ""}`,
      {
        method,
        headers: { "Content-Type": "application/json" },
        ...(method === "PUT" ? { body: JSON.stringify({ secrets }) } : {}),
      }
    ),
    createTestEnv({
      DB: ownerAuthorizationDatabase(),
      SCM_PROVIDER: "github",
      REPO_SECRETS_ENCRYPTION_KEY: "test-key",
    }),
    TEST_BACKGROUND_TASK_CONTEXT
  );
}

describe("team secret rebuild scheduling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scheduleImageBuildOnSave.mockReset();
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: "user-1" },
      request,
    }));
    vi.spyOn(TeamStore.prototype, "getById").mockResolvedValue({
      id: teamId,
      slug: "secrets",
      name: "Secrets",
      description: null,
      joinPolicy: "invite_only",
      defaultVisibility: "team",
      defaultEnvironmentId: null,
      grantsVersion: 0,
      archivedAt: null,
      createdAt: 1,
      updatedAt: 1,
    });
    vi.spyOn(TeamMembershipStore.prototype, "countLeads").mockResolvedValue(1);
    vi.spyOn(TeamSecretsStore.prototype, "setSecrets").mockResolvedValue({
      created: 0,
      updated: 1,
      keys: ["TOKEN"],
    });
    vi.spyOn(TeamSecretsStore.prototype, "deleteSecret").mockResolvedValue(true);
    vi.spyOn(EnvironmentStore.prototype, "list").mockResolvedValue({
      environments: [
        environment("owned-enabled", teamId, 1),
        environment("owned-disabled", teamId, 0),
        environment("other-enabled", "team-2", 1),
        environment("workspace-enabled", null, 1),
        environment("owned-enabled-2", teamId, 1),
      ],
      total: 5,
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it.each(["PUT", "DELETE"] as const)(
    "%s schedules only enabled, owned environments after commit",
    async (method) => {
      const mutation =
        method === "PUT"
          ? vi.mocked(TeamSecretsStore.prototype.setSecrets)
          : vi.mocked(TeamSecretsStore.prototype.deleteSecret);
      mocks.scheduleImageBuildOnSave.mockImplementation(() => {
        expect(mutation.mock.settledResults[0]?.type).toBe("fulfilled");
      });

      expect((await request(method)).status).toBe(200);
      expect(mocks.scheduleImageBuildOnSave.mock.calls.map((call) => call[1])).toEqual([
        { kind: "environment", id: "owned-enabled" },
        { kind: "environment", id: "owned-enabled-2" },
      ]);
    }
  );

  it.each(["PUT", "DELETE"] as const)(
    "%s stays successful when rebuild enumeration fails without logging bound values",
    async (method) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.mocked(EnvironmentStore.prototype.list).mockRejectedValue(
        new Error("sensitive-bound-value")
      );

      const response = await request(method);
      expect(response.status).toBe(200);
      expect(mocks.scheduleImageBuildOnSave).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("sensitive-bound-value");
      expect(await response.text()).not.toContain("sensitive-bound-value");
    }
  );

  it("does not enumerate or rebuild for an empty write or a missing delete", async () => {
    vi.mocked(TeamSecretsStore.prototype.setSecrets).mockResolvedValue({
      created: 0,
      updated: 0,
      keys: [],
    });
    expect((await request("PUT", {})).status).toBe(200);
    vi.mocked(TeamSecretsStore.prototype.deleteSecret).mockResolvedValue(false);
    expect((await request("DELETE")).status).toBe(404);
    expect(EnvironmentStore.prototype.list).not.toHaveBeenCalled();
    expect(mocks.scheduleImageBuildOnSave).not.toHaveBeenCalled();
  });

  it.each(["PUT", "DELETE"] as const)(
    "%s does not rebuild after a failed mutation",
    async (method) => {
      vi.mocked(TeamSecretsStore.prototype.setSecrets).mockRejectedValue(new Error("write failed"));
      vi.mocked(TeamSecretsStore.prototype.deleteSecret).mockRejectedValue(
        new Error("write failed")
      );
      expect((await request(method)).status).toBe(503);
      expect(EnvironmentStore.prototype.list).not.toHaveBeenCalled();
      expect(mocks.scheduleImageBuildOnSave).not.toHaveBeenCalled();
    }
  );
});
