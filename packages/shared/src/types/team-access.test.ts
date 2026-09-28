import { describe, expect, it } from "vitest";
import { resolveTeamAccess } from "./team-access";
import type { Team, TeamRole } from "./teams";

const baseTeam: Team = {
  id: "team_one",
  slug: "one",
  name: "One",
  description: null,
  joinPolicy: "invite_only",
  defaultVisibility: "team",
  defaultEnvironmentId: null,
  grantsVersion: 0,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

describe("resolveTeamAccess", () => {
  it.each(["owner", "administrator", "member", "viewer", "custom"] as const)(
    "resolves %s across memberships, policies and archive states",
    (roleKey) => {
      for (const membership of [null, "member", "lead"] as const) {
        for (const joinPolicy of ["open", "invite_only"] as const) {
          for (const archivedAt of [null, 123]) {
            const isAdmin = roleKey === "owner" || roleKey === "administrator";
            const manages = isAdmin || membership === "lead";
            const access = resolveTeamAccess(
              {
                userId: "user_one",
                roleKey,
                memberships: new Map<string, TeamRole>(
                  membership ? [[baseTeam.id, membership]] : []
                ),
              },
              { ...baseTeam, joinPolicy, archivedAt, leadCount: 2 }
            );
            expect(access).toEqual({
              canJoin: membership === null && joinPolicy === "open" && archivedAt === null,
              canLeave: membership !== null,
              canEditMetadata: manages,
              canManageMembers: manages,
              canManageRepositories: manages,
              canManageBindings: manages,
              canManageAutomations: manages,
              canManageSecrets: manages,
              canArchive: manages,
            });
          }
        }
      }
    }
  );

  it("does not allow the sole lead to leave", () => {
    expect(
      resolveTeamAccess(
        { userId: "user_one", roleKey: "member", memberships: new Map([[baseTeam.id, "lead"]]) },
        { ...baseTeam, leadCount: 1 }
      ).canLeave
    ).toBe(false);
  });
});
