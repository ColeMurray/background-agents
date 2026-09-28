import { describe, expect, it } from "vitest";
import { permissionsForBuiltInRole, type BuiltInRoleKey, type PermissionId } from "../rbac";
import {
  resolveAutomationAccess,
  resolveEnvironmentAccess,
  resolveSessionAccess,
  sessionCapabilities,
  type SessionAction,
  type SessionAccessRow,
  type SessionDenialReason,
  type SessionViewer,
} from "./session-access";
import type { TeamRole } from "./teams";

const actions: SessionAction[] = [
  "read",
  "collaborate",
  "lifecycle",
  "delete",
  "sandbox",
  "move",
  "manageCollaborators",
  "changeVisibility",
];
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

describe("resolveSessionAccess", () => {
  it("resolves every visibility, relation, role key, and suspension combination", () => {
    for (const visibility of visibilities) {
      for (const relation of relations) {
        for (const roleKey of roles) {
          for (const suspended of [false, true]) {
            const actor = viewer(relation, roleKey, suspended);
            const result = resolveSessionAccess(actor, { ...row, visibility });
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
            const manageCollaborators = read && (isOwner || roleKey === "owner");
            const expected = {
              read,
              collaborate: read && has("sessions.collaborate") && privateActor,
              lifecycle: read && has("sessions.lifecycle"),
              delete: read && has("sessions.delete") && privileged,
              sandbox: read && has("sessions.sandbox_access") && privateActor,
              move: read && has("sessions.lifecycle") && privileged,
              manageCollaborators,
              changeVisibility: visibility === "private" ? manageCollaborators : read && privileged,
              auditedBreakGlass:
                read &&
                visibility === "private" &&
                roleKey === "owner" &&
                !isOwner &&
                !isCollaborator,
            };
            const readReason: SessionDenialReason | undefined = suspended
              ? "suspended"
              : !visible
                ? visibility === "private"
                  ? "private"
                  : "not_member"
                : !has("sessions.read")
                  ? "missing_permission"
                  : undefined;
            const deniedReasons: Partial<Record<SessionAction, SessionDenialReason>> = {};
            for (const action of actions) {
              if (expected[action]) continue;
              if (!read) {
                deniedReasons[action] = readReason;
              } else if (action === "collaborate" || action === "sandbox") {
                const grant =
                  action === "collaborate" ? "sessions.collaborate" : "sessions.sandbox_access";
                deniedReasons[action] = !has(grant) ? "missing_permission" : "not_owner_or_lead";
              } else if (action === "lifecycle" || action === "move" || action === "delete") {
                const grant = action === "delete" ? "sessions.delete" : "sessions.lifecycle";
                deniedReasons[action] = !has(grant) ? "missing_permission" : "not_owner_or_lead";
              } else {
                deniedReasons[action] = "not_owner_or_lead";
              }
            }
            expect(
              result,
              `${visibility}, ${relation}, ${roleKey}, suspended=${suspended}`
            ).toEqual({
              ...expected,
              ...(readReason ? { reason: readReason } : {}),
              deniedReasons,
            });
            expect(sessionCapabilities(result)).toEqual({
              canRead: expected.read,
              canCollaborate: expected.collaborate,
              canManageLifecycle: expected.lifecycle,
              canDelete: expected.delete,
              canMove: expected.move,
              canSandbox: expected.sandbox,
              canManageCollaborators: expected.manageCollaborators,
              canChangeVisibility: expected.changeVisibility,
            });
          }
        }
      }
    }
  });

  it("uses role keys, not built-in role IDs, and reports a non-owner member's delete denial", () => {
    const member = viewer("team member", "member");
    expect(resolveSessionAccess(member, row).deniedReasons.delete).toBe("not_owner_or_lead");
    const admin = viewer("non-member", "administrator");
    expect(resolveSessionAccess(admin, row).delete).toBe(true);
    expect(resolveSessionAccess({ ...admin, roleKey: null }, row).reason).toBe("not_member");
  });

  it("checks each grant before ownership, including custom grants and private write restrictions", () => {
    const member = viewer("team member", null, false, ["sessions.read"]);
    const result = resolveSessionAccess(member, row);
    expect(result.deniedReasons).toEqual({
      collaborate: "missing_permission",
      lifecycle: "missing_permission",
      delete: "missing_permission",
      sandbox: "missing_permission",
      move: "missing_permission",
      manageCollaborators: "not_owner_or_lead",
      changeVisibility: "not_owner_or_lead",
    });
    const owner = viewer("owner", null, false, ["sessions.read", "sessions.delete"]);
    expect(resolveSessionAccess(owner, row).delete).toBe(true);
    const breakGlass = viewer("non-member", "owner");
    expect(resolveSessionAccess(breakGlass, { ...row, visibility: "private" })).toMatchObject({
      read: true,
      collaborate: false,
      sandbox: false,
      manageCollaborators: true,
      changeVisibility: true,
      deniedReasons: { collaborate: "not_owner_or_lead", sandbox: "not_owner_or_lead" },
    });
  });

  it("treats a null team as workspace ownership, without granting team-lead rights", () => {
    const workspaceRow = {
      ...row,
      ownerTeamId: null,
      visibility: "workspace",
    } satisfies SessionAccessRow;
    expect(resolveSessionAccess(viewer("team lead", "member"), workspaceRow)).toMatchObject({
      read: true,
      delete: false,
      move: false,
      deniedReasons: { delete: "not_owner_or_lead", move: "not_owner_or_lead" },
    });
  });

  it("does not use session ownership as a substitute for team membership", () => {
    const ownerWithoutMembership = { ...viewer("owner", "member"), memberships: new Map() };
    expect(resolveSessionAccess(ownerWithoutMembership, row).reason).toBe("not_member");
    expect(
      resolveSessionAccess(ownerWithoutMembership, { ...row, visibility: "private" })
    ).toMatchObject({
      read: true,
      collaborate: true,
      sandbox: true,
      auditedBreakGlass: false,
    });
  });

  it("does not treat a missing session owner as the viewer or grant break-glass without read", () => {
    const orphan = { ...row, ownerUserId: null, visibility: "private" } satisfies SessionAccessRow;
    expect(resolveSessionAccess(viewer("owner", "member"), orphan).reason).toBe("private");
    const ownerWithoutRead = viewer("non-member", "owner", false, []);
    expect(resolveSessionAccess(ownerWithoutRead, orphan)).toMatchObject({
      read: false,
      reason: "missing_permission",
      auditedBreakGlass: false,
    });
  });

  it.each([null, "team_one", "team_other"])(
    "limits service reads for team binding %s",
    (teamId) => {
      for (const visibility of visibilities) {
        const result = resolveSessionAccess({ kind: "service", teamId }, { ...row, visibility });
        const read =
          visibility === "workspace" || (visibility === "team" && teamId !== "team_other");
        expect(result).toEqual({
          read,
          collaborate: false,
          lifecycle: false,
          delete: false,
          sandbox: false,
          move: false,
          manageCollaborators: false,
          changeVisibility: false,
          auditedBreakGlass: false,
          ...(read ? {} : { reason: visibility === "private" ? "private" : "not_member" }),
          deniedReasons: Object.fromEntries(
            actions
              .filter((action) => !read || action !== "read")
              .map((action) => [
                action,
                read ? "missing_permission" : visibility === "private" ? "private" : "not_member",
              ])
          ),
        });
      }
    }
  );
});

describe("resolveAutomationAccess", () => {
  it("uses team membership, executor and lead own grants, and admin any grants", () => {
    const permissions: PermissionId[] = ["automations.manage.own", "automations.trigger.own"];
    for (const relation of relations) {
      for (const roleKey of roles) {
        for (const suspended of [false, true]) {
          const actor = viewer(relation, roleKey, suspended, permissions);
          const member = actor.memberships.has("team_one");
          const owner = roleKey === "owner" || roleKey === "administrator";
          const executor = relation === "owner";
          const lead = relation === "team lead";
          expect(
            resolveAutomationAccess(actor, {
              ownerTeamId: "team_one",
              executorUserId: "user_owner",
            })
          ).toEqual({
            read: !suspended && (member || owner),
            manage: !suspended && (member || owner) && (executor || lead),
            trigger: !suspended && (member || owner) && (executor || lead),
            move: !suspended && (member || owner) && (executor || lead),
          });
        }
      }
    }
  });

  it("requires each scoped permission and lets an admin with the any grant act across teams", () => {
    const admin = viewer("non-member", "administrator", false, [
      "automations.manage.any",
      "automations.trigger.any",
    ]);
    expect(
      resolveAutomationAccess(admin, { ownerTeamId: "team_one", executorUserId: "user_owner" })
    ).toEqual({
      read: true,
      manage: true,
      trigger: true,
      move: true,
    });
    expect(
      resolveAutomationAccess(viewer("team lead", "member", false, ["automations.trigger.own"]), {
        ownerTeamId: "team_one",
        executorUserId: "user_owner",
      })
    ).toEqual({ read: true, manage: false, trigger: true, move: false });
    expect(
      resolveAutomationAccess(viewer("team member", "member"), {
        ownerTeamId: "team_one",
        executorUserId: "user_owner",
      })
    ).toEqual({ read: true, manage: false, trigger: false, move: false });
  });

  it("preserves workspace-level access and denies service viewers", () => {
    const workspaceRow = { ownerTeamId: null, executorUserId: "user_none" };
    expect(resolveAutomationAccess(viewer("non-member", "member"), workspaceRow)).toEqual({
      read: true,
      manage: true,
      trigger: true,
      move: true,
    });
    expect(resolveAutomationAccess({ kind: "service", teamId: null }, workspaceRow)).toEqual({
      read: false,
      manage: false,
      trigger: false,
      move: false,
    });
  });
});

describe("resolveEnvironmentAccess", () => {
  it("requires membership or admin status and the appropriate read, use, and manage grants", () => {
    for (const relation of relations) {
      for (const roleKey of roles) {
        for (const suspended of [false, true]) {
          const actor = viewer(relation, roleKey, suspended);
          const member = actor.memberships.has("team_one");
          const admin = roleKey === "owner" || roleKey === "administrator";
          const eligible = !suspended && (member || admin);
          expect(resolveEnvironmentAccess(actor, { ownerTeamId: "team_one" })).toEqual({
            read: eligible && actor.permissions.includes("environments.read"),
            use: eligible && actor.permissions.includes("environments.use"),
            manage:
              eligible &&
              (relation === "team lead" || admin) &&
              actor.permissions.includes("environments.manage"),
          });
        }
      }
    }
  });

  it("does not infer grants from team leadership or role keys", () => {
    const lead = viewer("team lead", null, false, ["environments.use"]);
    expect(resolveEnvironmentAccess(lead, { ownerTeamId: "team_one" })).toEqual({
      read: false,
      use: true,
      manage: false,
    });
  });

  it("preserves workspace-level environment access and denies service viewers", () => {
    expect(resolveEnvironmentAccess(viewer("non-member", "member"), { ownerTeamId: null })).toEqual(
      {
        read: true,
        use: true,
        manage: false,
      }
    );
    expect(
      resolveEnvironmentAccess({ kind: "service", teamId: null }, { ownerTeamId: null })
    ).toEqual({
      read: false,
      use: false,
      manage: false,
    });
  });
});
