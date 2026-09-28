import { hasScopedPermission, type BuiltInRoleKey, type PermissionId } from "../rbac";
import type { SessionVisibility, TeamRole } from "./teams";

export type SessionAction =
  | "read"
  | "collaborate"
  | "lifecycle"
  | "delete"
  | "sandbox"
  | "move"
  | "manageCollaborators"
  | "changeVisibility";

export type SessionViewer =
  | {
      kind: "user";
      userId: string;
      roleKey: BuiltInRoleKey | null;
      permissions: readonly PermissionId[];
      suspended: boolean;
      memberships: ReadonlyMap<string, TeamRole>;
    }
  /** An unbound bot (teamId null) reads every non-private session; private is always refused. */
  | { kind: "service"; teamId: string | null };

export interface SessionAccessRow {
  id: string;
  ownerUserId: string | null;
  ownerTeamId: string | null;
  visibility: SessionVisibility;
  collaboratorIds: readonly string[];
}

export type SessionDenialReason =
  | "not_member"
  | "private"
  | "suspended"
  | "missing_permission"
  | "not_owner_or_lead";

export interface SessionAccess {
  read: boolean;
  collaborate: boolean;
  lifecycle: boolean;
  delete: boolean;
  sandbox: boolean;
  move: boolean;
  manageCollaborators: boolean;
  changeVisibility: boolean;
  reason?: SessionDenialReason;
  deniedReasons: Partial<Record<SessionAction, SessionDenialReason>>;
  auditedBreakGlass: boolean;
}

export interface SessionCapabilities {
  canRead: boolean;
  canCollaborate: boolean;
  canManageLifecycle: boolean;
  canDelete: boolean;
  canMove: boolean;
  canSandbox: boolean;
  canManageCollaborators: boolean;
  canChangeVisibility: boolean;
}

const SESSION_ACTIONS: readonly SessionAction[] = [
  "read",
  "collaborate",
  "lifecycle",
  "delete",
  "sandbox",
  "move",
  "manageCollaborators",
  "changeVisibility",
];

function deniedSessionAccess(reason: SessionDenialReason): SessionAccess {
  const deniedReasons: SessionAccess["deniedReasons"] = {};
  for (const action of SESSION_ACTIONS) deniedReasons[action] = reason;
  return {
    read: false,
    collaborate: false,
    lifecycle: false,
    delete: false,
    sandbox: false,
    move: false,
    manageCollaborators: false,
    changeVisibility: false,
    reason,
    deniedReasons,
    auditedBreakGlass: false,
  };
}

/** Resolves access from the persisted session row, never from session participants. */
export function resolveSessionAccess(viewer: SessionViewer, row: SessionAccessRow): SessionAccess {
  if (viewer.kind === "service") {
    if (row.visibility === "private") return deniedSessionAccess("private");
    if (row.visibility === "team" && viewer.teamId !== null && viewer.teamId !== row.ownerTeamId) {
      return deniedSessionAccess("not_member");
    }
    return {
      read: true,
      collaborate: false,
      lifecycle: false,
      delete: false,
      sandbox: false,
      move: false,
      manageCollaborators: false,
      changeVisibility: false,
      deniedReasons: {
        collaborate: "missing_permission",
        lifecycle: "missing_permission",
        delete: "missing_permission",
        sandbox: "missing_permission",
        move: "missing_permission",
        manageCollaborators: "missing_permission",
        changeVisibility: "missing_permission",
      },
      auditedBreakGlass: false,
    };
  }

  if (viewer.suspended) return deniedSessionAccess("suspended");

  const isOwner = row.ownerUserId !== null && row.ownerUserId === viewer.userId;
  const isCollaborator = row.collaboratorIds.includes(viewer.userId);
  const teamRole = row.ownerTeamId === null ? undefined : viewer.memberships.get(row.ownerTeamId);
  const isWsOwner = viewer.roleKey === "owner";
  const isAdmin = isWsOwner || viewer.roleKey === "administrator";
  const visible =
    row.visibility === "workspace" ||
    (row.visibility === "team" && (teamRole !== undefined || isAdmin)) ||
    (row.visibility === "private" && (isOwner || isCollaborator || isWsOwner));
  if (!visible) return deniedSessionAccess(row.visibility === "private" ? "private" : "not_member");

  const has = (permission: PermissionId) => viewer.permissions.includes(permission);
  if (!has("sessions.read")) return deniedSessionAccess("missing_permission");

  const privateActor = row.visibility !== "private" || isOwner || isCollaborator;
  const privileged = isOwner || teamRole === "lead" || isAdmin;
  const collaborate = has("sessions.collaborate") && privateActor;
  const lifecycle = has("sessions.lifecycle");
  const sandbox = has("sessions.sandbox_access") && privateActor;
  const canDelete = has("sessions.delete") && privileged;
  const move = lifecycle && privileged;
  const manageCollaborators = isOwner || isWsOwner;
  const changeVisibility = row.visibility === "private" ? manageCollaborators : privileged;
  const deniedReasons: SessionAccess["deniedReasons"] = {};
  if (!collaborate) {
    deniedReasons.collaborate = has("sessions.collaborate")
      ? "not_owner_or_lead"
      : "missing_permission";
  }
  if (!lifecycle) deniedReasons.lifecycle = "missing_permission";
  if (!sandbox) {
    deniedReasons.sandbox = has("sessions.sandbox_access")
      ? "not_owner_or_lead"
      : "missing_permission";
  }
  if (!canDelete) {
    deniedReasons.delete = has("sessions.delete") ? "not_owner_or_lead" : "missing_permission";
  }
  if (!move) deniedReasons.move = lifecycle ? "not_owner_or_lead" : "missing_permission";
  if (!manageCollaborators) deniedReasons.manageCollaborators = "not_owner_or_lead";
  if (!changeVisibility) deniedReasons.changeVisibility = "not_owner_or_lead";

  return {
    read: true,
    collaborate,
    lifecycle,
    delete: canDelete,
    sandbox,
    move,
    manageCollaborators,
    changeVisibility,
    deniedReasons,
    auditedBreakGlass: row.visibility === "private" && isWsOwner && !isOwner && !isCollaborator,
  };
}

export function sessionCapabilities(access: SessionAccess): SessionCapabilities {
  return {
    canRead: access.read,
    canCollaborate: access.collaborate,
    canManageLifecycle: access.lifecycle,
    canDelete: access.delete,
    canMove: access.move,
    canSandbox: access.sandbox,
    canManageCollaborators: access.manageCollaborators,
    canChangeVisibility: access.changeVisibility,
  };
}

export interface AutomationAccess {
  read: boolean;
  manage: boolean;
  trigger: boolean;
  move: boolean;
}

export function resolveAutomationAccess(
  viewer: SessionViewer,
  row: { ownerTeamId: string | null; executorUserId: string | null }
): AutomationAccess {
  if (viewer.kind === "service") {
    return {
      read: row.ownerTeamId === null || viewer.teamId === null || row.ownerTeamId === viewer.teamId,
      manage: false,
      trigger: false,
      move: false,
    };
  }
  if (viewer.suspended) {
    return { read: false, manage: false, trigger: false, move: false };
  }
  const teamRole = row.ownerTeamId === null ? undefined : viewer.memberships.get(row.ownerTeamId);
  const isAdmin = viewer.roleKey === "owner" || viewer.roleKey === "administrator";
  const eligible = row.ownerTeamId === null || teamRole !== undefined || isAdmin;
  const own = row.executorUserId === viewer.userId || teamRole === "lead";
  const manage = eligible && hasScopedPermission("automations.manage", viewer.permissions, own);
  const trigger = eligible && hasScopedPermission("automations.trigger", viewer.permissions, own);
  return {
    read: eligible && viewer.permissions.includes("automations.read"),
    manage,
    trigger,
    move: manage,
  };
}

export interface EnvironmentAccess {
  read: boolean;
  manage: boolean;
  use: boolean;
}

export function resolveEnvironmentAccess(
  viewer: SessionViewer,
  row: { ownerTeamId: string | null }
): EnvironmentAccess {
  if (viewer.kind === "service") {
    const allowed =
      row.ownerTeamId === null || viewer.teamId === null || row.ownerTeamId === viewer.teamId;
    return { read: allowed, manage: false, use: allowed };
  }
  if (viewer.suspended) {
    return { read: false, manage: false, use: false };
  }
  const teamRole = row.ownerTeamId === null ? undefined : viewer.memberships.get(row.ownerTeamId);
  const isAdmin = viewer.roleKey === "owner" || viewer.roleKey === "administrator";
  const eligible = row.ownerTeamId === null || teamRole !== undefined || isAdmin;
  return {
    read: eligible && viewer.permissions.includes("environments.read"),
    manage:
      eligible &&
      (teamRole === "lead" || isAdmin) &&
      viewer.permissions.includes("environments.manage"),
    use: eligible && viewer.permissions.includes("environments.use"),
  };
}
