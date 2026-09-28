import {
  hasScopedPermission,
  resolveScopedPermission,
  type BuiltInRoleKey,
  type PermissionId,
} from "../rbac";
import type { SessionVisibility, TeamRole } from "./teams";

export const SESSION_ACTIONS = [
  "read",
  "collaborate",
  "lifecycle",
  "delete",
  "sandbox",
  "move",
  "manageCollaborators",
  "changeVisibility",
] as const;
export type SessionAction = (typeof SESSION_ACTIONS)[number];

export const AUTOMATION_ACTIONS = ["read", "manage", "trigger", "move"] as const;
export type AutomationAction = (typeof AUTOMATION_ACTIONS)[number];

export const ENVIRONMENT_ACTIONS = ["read", "manage", "use", "move"] as const;
export type EnvironmentAction = (typeof ENVIRONMENT_ACTIONS)[number];

export type AccessDenialReason =
  | "suspended"
  | "not_member"
  | "private"
  | "missing_permission"
  | "not_owner_or_lead"
  | "not_collaborator";
export type AuditObligation = "session.private_break_glass";
export type AccessDecision =
  | { allowed: true; audit?: AuditObligation }
  | { allowed: false; reason: AccessDenialReason };

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

/** Checks one session action using the persisted row, never session participants. */
export function checkSessionAccess(
  viewer: SessionViewer,
  row: SessionAccessRow,
  action: SessionAction
): AccessDecision {
  if (viewer.kind === "service") {
    if (row.visibility === "private") return { allowed: false, reason: "private" };
    if (row.visibility === "team" && viewer.teamId !== null && viewer.teamId !== row.ownerTeamId) {
      return { allowed: false, reason: "not_member" };
    }
    return action === "read" ? { allowed: true } : { allowed: false, reason: "missing_permission" };
  }

  if (viewer.suspended) return { allowed: false, reason: "suspended" };

  const isOwner = row.ownerUserId !== null && row.ownerUserId === viewer.userId;
  const isCollaborator = row.collaboratorIds.includes(viewer.userId);
  const teamRole = row.ownerTeamId === null ? undefined : viewer.memberships.get(row.ownerTeamId);
  const isWsOwner = viewer.roleKey === "owner";
  const isAdmin = isWsOwner || viewer.roleKey === "administrator";
  const visible =
    row.visibility === "workspace" ||
    (row.visibility === "team" && (teamRole !== undefined || isAdmin)) ||
    (row.visibility === "private" && (isOwner || isCollaborator || isWsOwner));
  if (!visible) {
    return { allowed: false, reason: row.visibility === "private" ? "private" : "not_member" };
  }

  const has = (permission: PermissionId) => viewer.permissions.includes(permission);
  if (!has("sessions.read")) return { allowed: false, reason: "missing_permission" };

  if (action === "read") {
    return row.visibility === "private" && isWsOwner && !isOwner && !isCollaborator
      ? { allowed: true, audit: "session.private_break_glass" }
      : { allowed: true };
  }
  if (action === "collaborate" || action === "sandbox") {
    if (!has(action === "collaborate" ? "sessions.collaborate" : "sessions.sandbox_access")) {
      return { allowed: false, reason: "missing_permission" };
    }
    if (row.visibility === "private" && !isOwner && !isCollaborator) {
      return { allowed: false, reason: "not_collaborator" };
    }
    return { allowed: true };
  }
  if (action === "lifecycle" || action === "delete" || action === "move") {
    if (!has(action === "delete" ? "sessions.delete" : "sessions.lifecycle")) {
      return { allowed: false, reason: "missing_permission" };
    }
    if (action !== "lifecycle" && !isOwner && teamRole !== "lead" && !isAdmin) {
      return { allowed: false, reason: "not_owner_or_lead" };
    }
    return { allowed: true };
  }
  if (action === "manageCollaborators") {
    return isOwner || isWsOwner
      ? { allowed: true }
      : { allowed: false, reason: "not_owner_or_lead" };
  }
  const canChange =
    row.visibility === "private" ? isOwner || isWsOwner : isOwner || teamRole === "lead" || isAdmin;
  return canChange ? { allowed: true } : { allowed: false, reason: "not_owner_or_lead" };
}

export function sessionCapabilities(
  viewer: SessionViewer,
  row: SessionAccessRow
): SessionCapabilities {
  return {
    canRead: checkSessionAccess(viewer, row, "read").allowed,
    canCollaborate: checkSessionAccess(viewer, row, "collaborate").allowed,
    canManageLifecycle: checkSessionAccess(viewer, row, "lifecycle").allowed,
    canDelete: checkSessionAccess(viewer, row, "delete").allowed,
    canMove: checkSessionAccess(viewer, row, "move").allowed,
    canSandbox: checkSessionAccess(viewer, row, "sandbox").allowed,
    canManageCollaborators: checkSessionAccess(viewer, row, "manageCollaborators").allowed,
    canChangeVisibility: checkSessionAccess(viewer, row, "changeVisibility").allowed,
  };
}

export function checkAutomationAccess(
  viewer: SessionViewer,
  row: { ownerTeamId: string | null; executorUserId: string | null },
  action: AutomationAction
): AccessDecision {
  if (viewer.kind === "service") {
    const eligible =
      row.ownerTeamId === null || viewer.teamId === null || row.ownerTeamId === viewer.teamId;
    if (!eligible) return { allowed: false, reason: "not_member" };
    return action === "read" ? { allowed: true } : { allowed: false, reason: "missing_permission" };
  }
  if (viewer.suspended) return { allowed: false, reason: "suspended" };

  const teamRole = row.ownerTeamId === null ? undefined : viewer.memberships.get(row.ownerTeamId);
  const isAdmin = viewer.roleKey === "owner" || viewer.roleKey === "administrator";
  if (row.ownerTeamId !== null && teamRole === undefined && !isAdmin) {
    return { allowed: false, reason: "not_member" };
  }
  if (action === "read") {
    return viewer.permissions.includes("automations.read")
      ? { allowed: true }
      : { allowed: false, reason: "missing_permission" };
  }

  const stem = action === "trigger" ? "automations.trigger" : "automations.manage";
  const own = row.executorUserId === viewer.userId || teamRole === "lead";
  if (hasScopedPermission(stem, viewer.permissions, own)) return { allowed: true };
  return {
    allowed: false,
    reason:
      resolveScopedPermission(stem, viewer.permissions) === "own"
        ? "not_owner_or_lead"
        : "missing_permission",
  };
}

export function automationCapabilities(
  viewer: SessionViewer,
  row: { ownerTeamId: string | null; executorUserId: string | null }
) {
  return {
    canRead: checkAutomationAccess(viewer, row, "read").allowed,
    canManage: checkAutomationAccess(viewer, row, "manage").allowed,
    canTrigger: checkAutomationAccess(viewer, row, "trigger").allowed,
    canMove: checkAutomationAccess(viewer, row, "move").allowed,
  };
}

export function checkEnvironmentAccess(
  viewer: SessionViewer,
  row: { ownerTeamId: string | null },
  action: EnvironmentAction
): AccessDecision {
  if (viewer.kind === "service") {
    const eligible =
      row.ownerTeamId === null || viewer.teamId === null || row.ownerTeamId === viewer.teamId;
    if (!eligible) return { allowed: false, reason: "not_member" };
    return action === "read" || action === "use"
      ? { allowed: true }
      : { allowed: false, reason: "missing_permission" };
  }
  if (viewer.suspended) return { allowed: false, reason: "suspended" };

  const teamRole = row.ownerTeamId === null ? undefined : viewer.memberships.get(row.ownerTeamId);
  const isAdmin = viewer.roleKey === "owner" || viewer.roleKey === "administrator";
  if (row.ownerTeamId !== null && teamRole === undefined && !isAdmin) {
    return { allowed: false, reason: "not_member" };
  }
  const permission =
    action === "read"
      ? "environments.read"
      : action === "use"
        ? "environments.use"
        : "environments.manage";
  if (!viewer.permissions.includes(permission)) {
    return { allowed: false, reason: "missing_permission" };
  }
  if ((action === "manage" || action === "move") && teamRole !== "lead" && !isAdmin) {
    return { allowed: false, reason: "not_owner_or_lead" };
  }
  return { allowed: true };
}

export function environmentCapabilities(
  viewer: SessionViewer,
  row: { ownerTeamId: string | null }
) {
  return {
    canRead: checkEnvironmentAccess(viewer, row, "read").allowed,
    canManage: checkEnvironmentAccess(viewer, row, "manage").allowed,
    canUse: checkEnvironmentAccess(viewer, row, "use").allowed,
    canMove: checkEnvironmentAccess(viewer, row, "move").allowed,
  };
}
