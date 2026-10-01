import { describe, expect, it } from "vitest";
import { permissionsForBuiltInRole, type BuiltInRoleKey, type PermissionId } from "../rbac";
import {
  AUTOMATION_ACTIONS,
  ENVIRONMENT_ACTIONS,
  SESSION_ACTIONS,
  automationCapabilities,
  checkAutomationAccess,
  checkEnvironmentAccess,
  checkSessionAccess,
  environmentCapabilities,
  sessionCapabilities,
  type AccessDenialReason,
  type SessionAccessRow,
  type SessionViewer,
} from "./session-access";
import type { TeamRole } from "./teams";

const relations = [
  "owner",
  "collaborator",
  "team member",
  "team lead",
  "other-team member",
  "non-member",
] as const;
const roles = ["owner", "administrator", "member", "viewer", null] as const;
const visibilities = ["team", "workspace", "private"] as const;
const row: SessionAccessRow = {
  id: "session_one",
  ownerUserId: "user_owner",
  ownerTeamId: "team_one",
  visibility: "team",
  collaboratorIds: ["user_collaborator"],
};

function viewer(
  relation: (typeof relations)[number],
  roleKey: BuiltInRoleKey | null,
  suspended = false,
  permissions: readonly PermissionId[] = roleKey ? permissionsForBuiltInRole(roleKey) : []
): Extract<SessionViewer, { kind: "user" }> {
  const userId = {
    owner: "user_owner",
    collaborator: "user_collaborator",
    "team member": "user_member",
    "team lead": "user_lead",
    "other-team member": "user_other",
    "non-member": "user_none",
  }[relation];
  const membership: TeamRole | null =
    relation === "owner" || relation === "team member"
      ? "member"
      : relation === "team lead"
        ? "lead"
        : null;
  return {
    kind: "user",
    userId,
    roleKey,
    permissions,
    suspended,
    memberships: new Map<string, TeamRole>(
      membership
        ? [["team_one", membership]]
        : relation === "other-team member"
          ? [["team_other", "member"]]
          : []
    ),
  };
}

describe("checkSessionAccess", () => {
  it("decides every action across visibility, relation, role key, and suspension", () => {
    for (const visibility of visibilities) {
      for (const relation of relations) {
        for (const roleKey of roles) {
          for (const suspended of [false, true]) {
            const actor = viewer(relation, roleKey, suspended);
            const target = { ...row, visibility };
            const isOwner = relation === "owner";
            const isCollaborator = relation === "collaborator";
            const teamRole = actor.memberships.get("team_one");
            const isAdmin = roleKey === "owner" || roleKey === "administrator";
            const visible =
              visibility === "workspace" ||
              (visibility === "team" && (teamRole !== undefined || isAdmin)) ||
              (visibility === "private" && (isOwner || isCollaborator || roleKey === "owner"));
            const has = (permission: PermissionId) => actor.permissions.includes(permission);
            const read = !suspended && visible && has("sessions.read");
            const privileged = isOwner || teamRole === "lead" || isAdmin;
            const privateActor = visibility !== "private" || isOwner || isCollaborator;
            const canAct = read && teamRole !== undefined;
            const canManageCollaborators = canAct && (isOwner || roleKey === "owner");
            const permits = {
              read,
              collaborate: canAct && has("sessions.collaborate") && privateActor,
              lifecycle: canAct && has("sessions.lifecycle"),
              delete: canAct && has("sessions.delete") && privileged,
              sandbox: canAct && has("sessions.sandbox_access") && privateActor,
              manageCollaborators: canManageCollaborators,
              changeVisibility:
                visibility === "private" ? canManageCollaborators : canAct && privileged,
            };
            const readReason: AccessDenialReason = suspended
              ? "suspended"
              : !visible
                ? visibility === "private"
                  ? "private"
                  : "not_member"
                : "missing_permission";
            for (const action of SESSION_ACTIONS) {
              const decision = checkSessionAccess(actor, target, action);
              const context = `${visibility}, ${relation}, ${roleKey}, suspended=${suspended}, ${action}`;
              if (permits[action]) {
                const breakGlass =
                  action === "read" &&
                  visibility === "private" &&
                  roleKey === "owner" &&
                  !isOwner &&
                  !isCollaborator;
                expect(decision, context).toEqual({
                  allowed: true,
                  ...(breakGlass ? { audit: "session.private_break_glass" } : {}),
                });
                continue;
              }

              let reason: AccessDenialReason = readReason;
              if (read) {
                if (teamRole === undefined) {
                  reason = "not_member";
                } else if (action === "collaborate" || action === "sandbox") {
                  const grant =
                    action === "collaborate" ? "sessions.collaborate" : "sessions.sandbox_access";
                  reason = has(grant) ? "not_collaborator" : "missing_permission";
                } else if (action === "lifecycle" || action === "delete") {
                  const grant = action === "delete" ? "sessions.delete" : "sessions.lifecycle";
                  reason = has(grant) ? "not_owner_or_lead" : "missing_permission";
                } else {
                  reason = "not_owner_or_lead";
                }
              }
              expect(decision, context).toEqual({ allowed: false, reason });
            }
            expect(sessionCapabilities(actor, target)).toEqual({
              canRead: permits.read,
              canCollaborate: permits.collaborate,
              canManageLifecycle: permits.lifecycle,
              canDelete: permits.delete,
              canSandbox: permits.sandbox,
              canManageCollaborators: permits.manageCollaborators,
              canChangeVisibility: permits.changeVisibility,
            });
          }
        }
      }
    }
  });

  it("uses role keys and reports a non-owner member delete denial", () => {
    expect(checkSessionAccess(viewer("team member", "member"), row, "delete")).toEqual({
      allowed: false,
      reason: "not_owner_or_lead",
    });
    expect(checkSessionAccess(viewer("non-member", "administrator"), row, "delete")).toEqual({
      allowed: false,
      reason: "not_member",
    });
    expect(
      checkSessionAccess(viewer("non-member", null, false, ["sessions.read"]), row, "read")
    ).toEqual({
      allowed: false,
      reason: "not_member",
    });
  });

  it("checks the grant before ownership and distinguishes private participation", () => {
    const actor = viewer("team member", null, false, ["sessions.read"]);
    expect(checkSessionAccess(actor, row, "delete")).toEqual({
      allowed: false,
      reason: "missing_permission",
    });
    const breakGlass = viewer("team member", "owner");
    const privateRow = { ...row, visibility: "private" } satisfies SessionAccessRow;
    expect(checkSessionAccess(breakGlass, privateRow, "read")).toEqual({
      allowed: true,
      audit: "session.private_break_glass",
    });
    for (const action of ["collaborate", "sandbox"] as const) {
      expect(checkSessionAccess(breakGlass, privateRow, action)).toEqual({
        allowed: false,
        reason: "not_collaborator",
      });
    }
    expect(checkSessionAccess(breakGlass, privateRow, "lifecycle")).toEqual({ allowed: true });
    expect(checkSessionAccess(breakGlass, privateRow, "changeVisibility")).toEqual({
      allowed: true,
    });
  });

  it("does not give workspace rows team-lead rights or use ownership as team membership", () => {
    const actor = viewer("team lead", "member");
    const workspaceRow = {
      ...row,
      ownerTeamId: null,
      visibility: "workspace",
    } satisfies SessionAccessRow;
    expect(checkSessionAccess(actor, workspaceRow, "delete")).toEqual({
      allowed: false,
      reason: "not_owner_or_lead",
    });
    const ownerWithoutMembership = { ...viewer("owner", "member"), memberships: new Map() };
    expect(checkSessionAccess(ownerWithoutMembership, row, "read")).toEqual({
      allowed: false,
      reason: "not_member",
    });
    expect(
      checkSessionAccess(ownerWithoutMembership, { ...row, visibility: "private" }, "read")
    ).toEqual({ allowed: true });
  });

  it.each(visibilities)("keeps removed owners read-only at %s visibility", (visibility) => {
    const actor = { ...viewer("owner", "member"), memberships: new Map<string, TeamRole>() };
    const target = { ...row, visibility };
    expect(checkSessionAccess(actor, target, "read")).toEqual(
      visibility === "team" ? { allowed: false, reason: "not_member" } : { allowed: true }
    );
    for (const action of SESSION_ACTIONS) {
      if (action === "read") continue;
      expect(checkSessionAccess(actor, target, action)).toEqual({
        allowed: false,
        reason: "not_member",
      });
    }
  });

  it.each(["workspace", "private"] as const)(
    "preserves workspace-owned %s actions without team membership",
    (visibility) => {
      const target = { ...row, ownerTeamId: null, visibility };
      for (const relation of relations) {
        for (const role of roles) {
          const actor = viewer(relation, role);
          const withoutMembership = { ...actor, memberships: new Map<string, TeamRole>() };
          for (const action of SESSION_ACTIONS) {
            expect(checkSessionAccess(withoutMembership, target, action)).toEqual(
              checkSessionAccess(actor, target, action)
            );
          }
        }
      }
      expect(checkSessionAccess(viewer("collaborator", "member"), target, "collaborate")).toEqual({
        allowed: true,
      });
      expect(checkSessionAccess(viewer("non-member", "owner"), target, "lifecycle")).toEqual({
        allowed: true,
      });
    }
  );

  it("denies every action to a suspended owner before checking visibility or grants", () => {
    const actor = viewer("owner", "owner", true);
    for (const action of SESSION_ACTIONS) {
      expect(checkSessionAccess(actor, { ...row, visibility: "private" }, action)).toEqual({
        allowed: false,
        reason: "suspended",
      });
    }
  });

  it("does not mistake a null session owner for a viewer or audit a denied read", () => {
    const orphan = { ...row, ownerUserId: null, visibility: "private" } satisfies SessionAccessRow;
    expect(checkSessionAccess(viewer("owner", "member"), orphan, "read")).toEqual({
      allowed: false,
      reason: "private",
    });
    expect(checkSessionAccess(viewer("non-member", "owner", false, []), orphan, "read")).toEqual({
      allowed: false,
      reason: "missing_permission",
    });
  });

  it.each([null, "team_one", "team_other"])(
    "limits service reads for team binding %s",
    (teamId) => {
      const actor: SessionViewer = { kind: "service", teamId };
      for (const visibility of visibilities) {
        const target = { ...row, visibility };
        const canRead =
          visibility === "workspace" || (visibility === "team" && teamId !== "team_other");
        expect(checkSessionAccess(actor, target, "read")).toEqual(
          canRead
            ? { allowed: true }
            : { allowed: false, reason: visibility === "private" ? "private" : "not_member" }
        );
        for (const action of SESSION_ACTIONS) {
          if (action === "read") continue;
          expect(checkSessionAccess(actor, target, action)).toEqual({
            allowed: false,
            reason: canRead
              ? "missing_permission"
              : visibility === "private"
                ? "private"
                : "not_member",
          });
        }
      }
    }
  );
});

describe("checkAutomationAccess", () => {
  const target = { ownerTeamId: "team_one", executorUserId: "user_owner" };

  it("keeps scoped own grants independent of read and honors a team lead", () => {
    const actor = viewer("team lead", "member", false, [
      "automations.manage.own",
      "automations.trigger.own",
    ]);
    expect(checkAutomationAccess(actor, target, "read")).toEqual({
      allowed: false,
      reason: "missing_permission",
    });
    expect(checkAutomationAccess(actor, target, "manage")).toEqual({ allowed: true });
    expect(checkAutomationAccess(actor, target, "trigger")).toEqual({ allowed: true });
    expect(automationCapabilities(actor, target)).toEqual({
      canRead: false,
      canManage: true,
      canTrigger: true,
    });
  });

  it("requires automations.read while an executor can manage without it", () => {
    const actor = viewer("owner", "member", false, ["automations.manage.own"]);
    expect(checkAutomationAccess(actor, target, "read")).toEqual({
      allowed: false,
      reason: "missing_permission",
    });
    expect(checkAutomationAccess(actor, target, "manage")).toEqual({ allowed: true });
    expect(checkAutomationAccess(actor, target, "trigger")).toEqual({
      allowed: false,
      reason: "missing_permission",
    });
  });

  it("honors custom-role any inside its team and refuses it outside", () => {
    const actor = viewer("team member", null, false, [
      "automations.read",
      "automations.manage.any",
      "automations.trigger.any",
    ]);
    const other = { ownerTeamId: "team_other", executorUserId: "user_other" };
    for (const action of AUTOMATION_ACTIONS) {
      expect(checkAutomationAccess(actor, target, action)).toEqual({ allowed: true });
      expect(checkAutomationAccess(actor, other, action)).toEqual({
        allowed: false,
        reason: "not_member",
      });
    }
    expect(automationCapabilities(actor, other)).toEqual({
      canRead: false,
      canManage: false,
      canTrigger: false,
    });
  });

  it("requires ownership for own grants on workspace rows and grants admins any", () => {
    const workspace = { ownerTeamId: null, executorUserId: "user_other" };
    expect(checkAutomationAccess(viewer("team member", "member"), workspace, "manage")).toEqual({
      allowed: false,
      reason: "not_owner_or_lead",
    });
    const admin = viewer("non-member", "administrator", false, ["automations.manage.any"]);
    expect(checkAutomationAccess(admin, target, "manage")).toEqual({ allowed: true });
    expect(checkAutomationAccess(admin, target, "read")).toEqual({
      allowed: false,
      reason: "missing_permission",
    });
  });

  it.each([
    [null, null, true],
    [null, "team_one", true],
    ["team_one", "team_one", true],
    ["team_one", "team_other", false],
    ["team_other", "team_one", false],
    ["team_other", null, true],
  ] as const)(
    "limits service automation reads for row team %s and binding %s",
    (ownerTeamId, teamId, read) => {
      const actor: SessionViewer = { kind: "service", teamId };
      const resource = { ownerTeamId, executorUserId: null };
      expect(checkAutomationAccess(actor, resource, "read")).toEqual(
        read ? { allowed: true } : { allowed: false, reason: "not_member" }
      );
      for (const action of AUTOMATION_ACTIONS) {
        if (action === "read") continue;
        expect(checkAutomationAccess(actor, resource, action)).toEqual({
          allowed: false,
          reason: read ? "missing_permission" : "not_member",
        });
      }
    }
  );
});

describe("checkEnvironmentAccess", () => {
  const target = { ownerTeamId: "team_one" };

  it("checks distinct read, use, and manage decisions", () => {
    const actor = viewer("team lead", "member", false, ["environments.use", "environments.manage"]);
    expect(checkEnvironmentAccess(actor, target, "read")).toEqual({
      allowed: false,
      reason: "missing_permission",
    });
    expect(checkEnvironmentAccess(actor, target, "use")).toEqual({ allowed: true });
    expect(checkEnvironmentAccess(actor, target, "manage")).toEqual({ allowed: true });
    expect(environmentCapabilities(actor, target)).toEqual({
      canRead: false,
      canManage: true,
      canUse: true,
    });
  });

  it("requires the manage grant and lead/admin role independently", () => {
    expect(
      checkEnvironmentAccess(
        viewer("team lead", null, false, ["environments.use"]),
        target,
        "manage"
      )
    ).toEqual({ allowed: false, reason: "missing_permission" });
    expect(
      checkEnvironmentAccess(
        viewer("team member", null, false, ["environments.manage"]),
        target,
        "manage"
      )
    ).toEqual({ allowed: false, reason: "not_owner_or_lead" });
    expect(checkEnvironmentAccess(viewer("non-member", "administrator"), target, "manage")).toEqual(
      {
        allowed: true,
      }
    );
    expect(
      checkEnvironmentAccess(
        viewer("team lead", "member", false, ["environments.manage"]),
        { ownerTeamId: null },
        "manage"
      )
    ).toEqual({ allowed: false, reason: "not_owner_or_lead" });
  });

  it("denies suspended and outside-team users for every action", () => {
    for (const action of ENVIRONMENT_ACTIONS) {
      expect(checkEnvironmentAccess(viewer("team lead", "owner", true), target, action)).toEqual({
        allowed: false,
        reason: "suspended",
      });
      expect(checkEnvironmentAccess(viewer("non-member", "member"), target, action)).toEqual({
        allowed: false,
        reason: "not_member",
      });
    }
  });

  it.each([
    [null, null, true],
    [null, "team_other", true],
    ["team_one", "team_one", true],
    ["team_one", "team_other", false],
    ["team_one", null, true],
  ] as const)(
    "limits service environment use for row team %s and binding %s",
    (ownerTeamId, teamId, allowed) => {
      const actor: SessionViewer = { kind: "service", teamId };
      for (const action of ENVIRONMENT_ACTIONS) {
        expect(checkEnvironmentAccess(actor, { ownerTeamId }, action)).toEqual(
          action === "read" || action === "use"
            ? allowed
              ? { allowed: true }
              : { allowed: false, reason: "not_member" }
            : { allowed: false, reason: allowed ? "missing_permission" : "not_member" }
        );
      }
    }
  );
});
