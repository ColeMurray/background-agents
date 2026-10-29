import { afterEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import { TeamChannelBindingStore } from "../db/team-channel-bindings";
import { EnvironmentStore, toEnvironment, type EnvironmentRow } from "../db/environments";
import { TeamMembershipStore } from "../db/team-memberships";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import { TeamStore } from "../db/teams";
import {
  authorizationDatabase,
  createTestEnv,
  createTestRequestHandler,
  TEST_BACKGROUND_TASK_CONTEXT,
} from "../router.test-support";
import { environmentRoutes } from "./environments";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));
afterEach(() => vi.restoreAllMocks());

describe("environment catalog channel scope", () => {
  it.each(["slack", "linear"] as const)(
    "scopes an acting %s service using its canonical actor's actual membership",
    async (provider) => {
      const teamId = "team_selected";
      const row: EnvironmentRow = {
        id: "env_covered",
        owner_team_id: null,
        name: "covered",
        description: null,
        prebuild_enabled: 0,
        channel_associations: null,
        created_at: 1,
        updated_at: 1,
      };
      const repositories = [
        {
          environment_id: row.id,
          position: 0,
          repo_owner: "acme",
          repo_name: "repo-1",
          repo_id: 1,
          base_branch: "main",
        },
      ];
      mocks.authenticate.mockImplementation(async (request: Request) => ({
        principal: {
          kind: "service",
          service: provider === "slack" ? "slack-bot" : "linear-bot",
          actor: {
            provider,
            providerUserId: "U_ACTOR",
            participantUserId: `${provider}:U_ACTOR`,
            canonicalUserId: "user-1",
          },
        },
        request,
      }));
      vi.spyOn(TeamChannelBindingStore.prototype, "get").mockResolvedValue({
        provider,
        externalId: "C-CATALOG",
        teamId,
        kind: "source",
      });
      vi.spyOn(TeamStore.prototype, "isActive").mockResolvedValue(true);
      const membership = vi
        .spyOn(TeamMembershipStore.prototype, "listForUser")
        .mockResolvedValue(new Map([[teamId, "member"]]));
      vi.spyOn(TeamRepositoryGrantStore.prototype, "listForTeam").mockResolvedValue([
        { grant_kind: "repository", repo_external_id: 1 },
      ]);
      vi.spyOn(EnvironmentStore.prototype, "list").mockResolvedValue({
        environments: [row],
        total: 1,
      });
      vi.spyOn(EnvironmentStore.prototype, "getRepositoriesForEnvironmentIds").mockResolvedValue(
        new Map([[row.id, repositories]])
      );
      const handleRequest = createTestRequestHandler([environmentRoutes]);

      const response = await handleRequest(
        new Request(`https://test.local/environments?channel=${provider}:C-CATALOG`),
        createTestEnv({ DB: authorizationDatabase({ permissions: ["environments.read"] }) }),
        TEST_BACKGROUND_TASK_CONTEXT
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        environments: [
          {
            ...toEnvironment(row, repositories),
            capabilities: {
              canRead: true,
              canManage: false,
              canUse: false,
            },
          },
        ],
        total: 1,
      });
      expect(membership.mock.calls.length).toBeGreaterThan(0);
      expect(membership.mock.calls.every(([userId]) => userId === "user-1")).toBe(true);
    }
  );
});
