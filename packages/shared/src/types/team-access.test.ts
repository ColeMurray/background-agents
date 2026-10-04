import { describe, expect, it } from "vitest";
import type { PermissionId } from "../rbac";
import { resolveTeamAccess, resolveWorkspaceTeamAccess } from "./team-access";
import { meTeamsResponseSchema, teamCapabilitiesSchema, type Team, type TeamRole } from "./teams";

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
                suspended: false,
                permissions: [],
                memberships: new Map<string, TeamRole>(
                  membership ? [[baseTeam.id, membership]] : []
                ),
              },
              { ...baseTeam, joinPolicy, archivedAt, leadCount: 2 }
            );
            expect(access).toEqual({
              canReadTeamSessions: false,
              canReadTeamRepositories: isAdmin || membership !== null,
              canReadTeamEnvironments: false,
              canReadAutomations: false,
              canJoin: membership === null && joinPolicy === "open" && archivedAt === null,
              canLeave: membership !== null,
              canEditMetadata: manages,
              canManageMembers: manages,
              canManageRepositories: manages,
              canManageBindings: manages,
              canManageAutomations: manages,
              canManageEnvironments: manages,
              canManageSecrets: manages,
              canArchive: manages,
            });
          }
        }
      }
    }
  );

  it.each(["owner", "administrator", "member", "viewer", "custom", null] as const)(
    "resolves read and workspace capabilities for role %s independently of other read permissions",
    (roleKey) => {
      const permissionSets: PermissionId[][] = [
        [],
        ["sessions.read"],
        ["environments.read"],
        ["automations.read"],
        ["sessions.read", "environments.read"],
        ["sessions.read", "automations.read"],
        ["environments.read", "automations.read"],
        ["sessions.read", "environments.read", "automations.read"],
      ];
      for (const membership of [null, "member", "lead"] as const) {
        for (const suspended of [false, true]) {
          for (const readPermissions of permissionSets) {
            const viewer = {
              userId: "user_one",
              roleKey,
              suspended,
              permissions: ["automations.manage.any", ...readPermissions] satisfies PermissionId[],
              memberships: new Map<string, TeamRole>(membership ? [[baseTeam.id, membership]] : []),
            };
            const admin = roleKey === "owner" || roleKey === "administrator";
            const eligible = !suspended && (admin || membership !== null);
            // Archiving does not change read eligibility or the viewer's permissions.
            for (const archivedAt of [null, 123]) {
              expect(
                resolveTeamAccess(viewer, { ...baseTeam, archivedAt, leadCount: 2 })
              ).toMatchObject({
                canReadTeamSessions: eligible && readPermissions.includes("sessions.read"),
                canReadTeamRepositories: eligible,
                canReadTeamEnvironments: eligible && readPermissions.includes("environments.read"),
                canReadAutomations: eligible && readPermissions.includes("automations.read"),
              });
            }
            expect(resolveWorkspaceTeamAccess(viewer)).toEqual({
              canListAllTeams: !suspended && admin,
            });
          }
        }
      }
    }
  );

  it("does not allow the sole lead to leave", () => {
    expect(
      resolveTeamAccess(
        {
          userId: "user_one",
          roleKey: "member",
          suspended: false,
          permissions: [],
          memberships: new Map([[baseTeam.id, "lead"]]),
        },
        { ...baseTeam, leadCount: 1 }
      ).canLeave
    ).toBe(false);
  });
});

describe("team capability rollout compatibility", () => {
  it("preserves action grants while defaulting missing read capabilities to false", () => {
    const actions = {
      canJoin: true,
      canLeave: false,
      canEditMetadata: true,
      canManageMembers: true,
      canManageRepositories: true,
      canManageBindings: true,
      canManageAutomations: true,
      canManageEnvironments: true,
      canManageSecrets: true,
      canArchive: true,
    };
    expect(teamCapabilitiesSchema.parse(actions)).toEqual({
      ...actions,
      canReadTeamSessions: false,
      canReadTeamRepositories: false,
      canReadTeamEnvironments: false,
      canReadAutomations: false,
    });
  });

  it.each([undefined, {}, { canListAllTeams: true }, { canListAllTeams: false }])(
    "defaults absent workspace grants without rejecting old /me/teams responses: %j",
    (capabilities) => {
      expect(meTeamsResponseSchema.parse({ teams: [], capabilities })).toEqual({
        teams: [],
        requireTeamOnCreate: false,
        capabilities: { canListAllTeams: capabilities?.canListAllTeams ?? false },
      });
    }
  );
});
