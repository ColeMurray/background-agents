import {
  resolveScopedPermission,
  type BuiltInRoleKey,
  type PermissionId,
  type ScopedPermissionStem,
} from "../rbac";
import type { SessionVisibility, TeamRole } from "./teams";

export const SESSION_ACTIONS = [
  "read",
  "collaborate",
  "lifecycle",
  "delete",
  "sandbox",
  "manageCollaborators",
  "changeVisibility",
] as const;
export type SessionAction = (typeof SESSION_ACTIONS)[number];

export const AUTOMATION_ACTIONS = ["read", "manage", "trigger"] as const;
export type AutomationAction = (typeof AUTOMATION_ACTIONS)[number];

export const ENVIRONMENT_ACTIONS = ["read", "manage", "use"] as const;
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
  canSandbox: boolean;
  canManageCollaborators: boolean;
  canChangeVisibility: boolean;
}

type UserViewer = Extract<SessionViewer, { kind: "user" }>;
type ServiceViewer = Extract<SessionViewer, { kind: "service" }>;

interface Facts {
  permissions: readonly PermissionId[];
  has: (permission: PermissionId) => boolean;
}

type ActionRule<F extends Facts> =
  | { permission: PermissionId; when?: never; reason?: never; scoped?: never; owns?: never }
  | {
      permission?: PermissionId;
      when: (facts: F) => boolean;
      reason: AccessDenialReason;
      scoped?: never;
      owns?: never;
    }
  | {
      scoped: ScopedPermissionStem;
      owns: (facts: F) => boolean;
      permission?: never;
      when?: never;
      reason?: never;
    };

function permit(audit?: AuditObligation): AccessDecision {
  return audit ? { allowed: true, audit } : { allowed: true };
}

function deny(reason: AccessDenialReason): AccessDecision {
  return { allowed: false, reason };
}

function decide<F extends Facts>(rule: ActionRule<F>, facts: F): AccessDecision {
  if (rule.scoped) {
    const scope = resolveScopedPermission(rule.scoped, facts.permissions);
    if (scope === null) return deny("missing_permission");
    if (scope === "own" && !rule.owns(facts)) return deny("not_owner_or_lead");
    return permit();
  }
  if (rule.permission && !facts.has(rule.permission)) return deny("missing_permission");
  if (rule.when && !rule.when(facts)) return deny(rule.reason);
  return permit();
}

interface SessionFacts extends Facts {
  suspended: boolean;
  visibility: SessionVisibility;
  isPrivate: boolean;
  isOwner: boolean;
  isCollaborator: boolean;
  teamRole: TeamRole | undefined;
  isAdmin: boolean;
  isWsOwner: boolean;
  breakGlass: boolean;
}

function sessionFacts(viewer: UserViewer, row: SessionAccessRow): SessionFacts {
  const isOwner = row.ownerUserId !== null && row.ownerUserId === viewer.userId;
  const teamRole = row.ownerTeamId === null ? undefined : viewer.memberships.get(row.ownerTeamId);
  // A team-owned grant lapses with team membership, so stale collaborator rows grant nothing.
  const isCollaborator =
    row.collaboratorIds.includes(viewer.userId) &&
    (row.ownerTeamId === null || teamRole !== undefined);
  const isWsOwner = viewer.roleKey === "owner";
  const isAdmin = isWsOwner || viewer.roleKey === "administrator";
  const isPrivate = row.visibility === "private";
  return {
    permissions: viewer.permissions,
    has: (permission) => viewer.permissions.includes(permission),
    suspended: viewer.suspended,
    visibility: row.visibility,
    isPrivate,
    isOwner,
    isCollaborator,
    teamRole,
    isAdmin,
    isWsOwner,
    breakGlass: isPrivate && isWsOwner && !isOwner && !isCollaborator,
  };
}

function visible(facts: SessionFacts): boolean {
  return (
    facts.visibility === "workspace" ||
    (facts.visibility === "team" && (facts.teamRole !== undefined || facts.isAdmin)) ||
    (facts.isPrivate && (facts.isOwner || facts.isCollaborator || facts.isWsOwner))
  );
}

function readGate(facts: SessionFacts): AccessDecision | null {
  if (facts.suspended) return deny("suspended");
  if (!visible(facts)) return deny(facts.isPrivate ? "private" : "not_member");
  if (!facts.has("sessions.read")) return deny("missing_permission");
  return null;
}

const participant = (facts: SessionFacts) =>
  !facts.isPrivate || facts.isOwner || facts.isCollaborator;
const privileged = (facts: SessionFacts) =>
  facts.isOwner || facts.teamRole === "lead" || facts.isAdmin;
const ownerOrWsOwner = (facts: SessionFacts) => facts.isOwner || facts.isWsOwner;

const SESSION_RULES = {
  collaborate: {
    permission: "sessions.collaborate",
    when: participant,
    reason: "not_collaborator",
  },
  lifecycle: { permission: "sessions.lifecycle" },
  sandbox: {
    permission: "sessions.sandbox_access",
    when: participant,
    reason: "not_collaborator",
  },
  delete: { permission: "sessions.delete", when: privileged, reason: "not_owner_or_lead" },
  manageCollaborators: { when: ownerOrWsOwner, reason: "not_owner_or_lead" },
  changeVisibility: {
    when: (facts: SessionFacts) => (facts.isPrivate ? ownerOrWsOwner(facts) : privileged(facts)),
    reason: "not_owner_or_lead",
  },
} as const satisfies Record<Exclude<SessionAction, "read">, ActionRule<SessionFacts>>;

function checkServiceSessionAccess(
  viewer: ServiceViewer,
  row: SessionAccessRow,
  action: SessionAction
): AccessDecision {
  if (row.visibility === "private") return deny("private");
  if (row.visibility === "team" && viewer.teamId !== null && viewer.teamId !== row.ownerTeamId) {
    return deny("not_member");
  }
  return action === "read" ? permit() : deny("missing_permission");
}

/** Checks one session action using the persisted row, never session participants. */
export function checkSessionAccess(
  viewer: SessionViewer,
  row: SessionAccessRow,
  action: SessionAction
): AccessDecision {
  if (viewer.kind === "service") return checkServiceSessionAccess(viewer, row, action);
  const facts = sessionFacts(viewer, row);
  const read = readGate(facts);
  if (read) return read;
  if (action === "read")
    return permit(facts.breakGlass ? "session.private_break_glass" : undefined);
  if (row.ownerTeamId !== null && facts.teamRole === undefined) return deny("not_member");
  return decide(SESSION_RULES[action], facts);
}

export function sessionCapabilities(
  viewer: SessionViewer,
  row: SessionAccessRow
): SessionCapabilities {
  const permits = new Map(
    SESSION_ACTIONS.map((action) => [action, checkSessionAccess(viewer, row, action).allowed])
  );
  return {
    canRead: permits.get("read") === true,
    canCollaborate: permits.get("collaborate") === true,
    canManageLifecycle: permits.get("lifecycle") === true,
    canDelete: permits.get("delete") === true,
    canSandbox: permits.get("sandbox") === true,
    canManageCollaborators: permits.get("manageCollaborators") === true,
    canChangeVisibility: permits.get("changeVisibility") === true,
  };
}

interface OwnedFacts extends Facts {
  suspended: boolean;
  eligible: boolean;
  teamRole: TeamRole | undefined;
  isAdmin: boolean;
}

interface AutomationFacts extends OwnedFacts {
  isExecutor: boolean;
}

function automationFacts(
  viewer: UserViewer,
  row: { ownerTeamId: string | null; executorUserId: string | null }
): AutomationFacts {
  const teamRole = row.ownerTeamId === null ? undefined : viewer.memberships.get(row.ownerTeamId);
  const isAdmin = viewer.roleKey === "owner" || viewer.roleKey === "administrator";
  return {
    permissions: viewer.permissions,
    has: (permission) => viewer.permissions.includes(permission),
    suspended: viewer.suspended,
    eligible: row.ownerTeamId === null || teamRole !== undefined || isAdmin,
    teamRole,
    isAdmin,
    isExecutor: row.executorUserId === viewer.userId,
  };
}

function ownedGate(facts: OwnedFacts): AccessDecision | null {
  if (facts.suspended) return deny("suspended");
  if (!facts.eligible) return deny("not_member");
  return null;
}

const ownsAutomation = (facts: AutomationFacts) => facts.isExecutor || facts.teamRole === "lead";
const manageAutomation = { scoped: "automations.manage", owns: ownsAutomation } as const;
const AUTOMATION_RULES = {
  read: { permission: "automations.read" },
  manage: manageAutomation,
  trigger: { scoped: "automations.trigger", owns: ownsAutomation },
} as const satisfies Record<AutomationAction, ActionRule<AutomationFacts>>;

function checkServiceAutomationAccess(
  viewer: ServiceViewer,
  row: { ownerTeamId: string | null },
  action: AutomationAction
): AccessDecision {
  const eligible =
    row.ownerTeamId === null || viewer.teamId === null || row.ownerTeamId === viewer.teamId;
  if (!eligible) return deny("not_member");
  return action === "read" ? permit() : deny("missing_permission");
}

export function checkAutomationAccess(
  viewer: SessionViewer,
  row: { ownerTeamId: string | null; executorUserId: string | null },
  action: AutomationAction
): AccessDecision {
  if (viewer.kind === "service") return checkServiceAutomationAccess(viewer, row, action);
  const facts = automationFacts(viewer, row);
  return ownedGate(facts) ?? decide(AUTOMATION_RULES[action], facts);
}

export function automationCapabilities(
  viewer: SessionViewer,
  row: { ownerTeamId: string | null; executorUserId: string | null }
) {
  return {
    canRead: checkAutomationAccess(viewer, row, "read").allowed,
    canManage: checkAutomationAccess(viewer, row, "manage").allowed,
    canTrigger: checkAutomationAccess(viewer, row, "trigger").allowed,
  };
}

function environmentFacts(viewer: UserViewer, row: { ownerTeamId: string | null }): OwnedFacts {
  const teamRole = row.ownerTeamId === null ? undefined : viewer.memberships.get(row.ownerTeamId);
  const isAdmin = viewer.roleKey === "owner" || viewer.roleKey === "administrator";
  return {
    permissions: viewer.permissions,
    has: (permission) => viewer.permissions.includes(permission),
    suspended: viewer.suspended,
    eligible: row.ownerTeamId === null || teamRole !== undefined || isAdmin,
    teamRole,
    isAdmin,
  };
}

const manageEnvironment = {
  permission: "environments.manage",
  when: (facts: OwnedFacts) => facts.teamRole === "lead" || facts.isAdmin,
  reason: "not_owner_or_lead",
} as const;
const ENVIRONMENT_RULES = {
  read: { permission: "environments.read" },
  use: { permission: "environments.use" },
  manage: manageEnvironment,
} as const satisfies Record<EnvironmentAction, ActionRule<OwnedFacts>>;

function checkServiceEnvironmentAccess(
  viewer: ServiceViewer,
  row: { ownerTeamId: string | null },
  action: EnvironmentAction
): AccessDecision {
  const eligible =
    row.ownerTeamId === null || viewer.teamId === null || row.ownerTeamId === viewer.teamId;
  if (!eligible) return deny("not_member");
  return action === "read" || action === "use" ? permit() : deny("missing_permission");
}

export function checkEnvironmentAccess(
  viewer: SessionViewer,
  row: { ownerTeamId: string | null },
  action: EnvironmentAction
): AccessDecision {
  if (viewer.kind === "service") return checkServiceEnvironmentAccess(viewer, row, action);
  const facts = environmentFacts(viewer, row);
  const rule =
    row.ownerTeamId === null && action === "manage"
      ? { permission: "environments.manage" as const }
      : ENVIRONMENT_RULES[action];
  return ownedGate(facts) ?? decide(rule, facts);
}

export function environmentCapabilities(
  viewer: SessionViewer,
  row: { ownerTeamId: string | null }
) {
  return {
    canRead: checkEnvironmentAccess(viewer, row, "read").allowed,
    canManage: checkEnvironmentAccess(viewer, row, "manage").allowed,
    canUse: checkEnvironmentAccess(viewer, row, "use").allowed,
  };
}
