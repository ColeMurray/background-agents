import {
  checkSessionAccess,
  sessionCapabilities,
  type AccessDecision,
  type AccessDenialReason,
  type SessionAccessRow,
  type SessionAction,
  type SessionCapabilities,
  type SessionViewer,
} from "@open-inspect/shared";
import type { PermissionId } from "@open-inspect/shared/rbac";
import type { TeamRole } from "@open-inspect/shared/types/teams";
import { SessionCollaboratorStore } from "../db/session-collaborators";
import { SessionIndexStore } from "../db/session-index";
import { TeamMembershipStore } from "../db/team-memberships";
import type { RequestContext } from "../http/request-context";
import type { Env } from "../types";
import { auditPrivateSessionBreakGlass } from "./request-audit";
import { slackPostGate } from "./slack-post-gate";
import { recordShadowBatchDenial } from "./session-shadow-audit";
import {
  legacyPermissionForAction,
  parseTeamsEnforcementMode,
  resolverDecides,
  type TeamsEnforcementMode,
} from "./teams-enforcement";

export function teamsEnforcementMode(ctx: RequestContext, env: Env): TeamsEnforcementMode {
  return (ctx.teamsEnforcementMode ??= parseTeamsEnforcementMode(env.TEAMS_ENFORCEMENT));
}

export function viewerFromContext(
  ctx: RequestContext,
  memberships: ReadonlyMap<string, TeamRole>
): SessionViewer {
  const authorization = ctx.authorization;
  if (!authorization) {
    if (ctx.principal?.kind === "service" && !ctx.principal.actor)
      return { kind: "service", teamId: ctx.serviceTeamId ?? null };
    throw new Error("Missing request authorization");
  }
  return {
    kind: "user",
    userId: authorization.userId,
    roleKey: authorization.role.key,
    permissions: authorization.permissions,
    suspended: authorization.suspendedAt !== null,
    memberships,
  };
}

/** Preserve legacy read visibility without relaxing team-owned actions. */
export function effectiveSessionCapabilities(
  viewer: SessionViewer,
  row: SessionAccessRow,
  mode: TeamsEnforcementMode
): SessionCapabilities {
  const capabilities = sessionCapabilities(viewer, row);
  if (viewer.kind !== "user" || resolverDecides(mode, row, "read")) {
    return capabilities;
  }
  const has = (action: SessionAction, resolved: boolean) =>
    resolverDecides(mode, row, action)
      ? resolved
      : viewer.permissions.includes(legacyPermissionForAction(action));
  return {
    ...capabilities,
    canRead: has("read", capabilities.canRead),
    canCollaborate: has("collaborate", capabilities.canCollaborate),
    canManageLifecycle: has("lifecycle", capabilities.canManageLifecycle),
    canDelete: has("delete", capabilities.canDelete),
    canSandbox: has("sandbox", capabilities.canSandbox),
  };
}

export type SessionAdmissionOutcome =
  | { kind: "not_found" }
  | { kind: "action_denied"; reason: AccessDenialReason }
  | { kind: "allowed"; legacyPermission: PermissionId | null };

/** Resolve one D1 session; a null slot is used by body-ID batches, not item routes. */
export async function evaluateSessionAdmission(
  ctx: RequestContext,
  env: Env,
  sessionId: string,
  action: SessionAction,
  slot: "session" | "child" | null = "session",
  enforceAlways = false
): Promise<SessionAdmissionOutcome> {
  const mode = enforceAlways ? "on" : teamsEnforcementMode(ctx, env);
  const row = await new SessionIndexStore(ctx.db).get(sessionId);
  if (!row) return { kind: "not_found" };

  // Publication is narrower than workspace readability, including during rollback.
  if (
    ctx.serviceReadPurpose === "slack-post" &&
    slackPostGate(row, ctx.serviceTeamId ? { teamId: ctx.serviceTeamId } : null)
  ) {
    const admission = {
      row: { ...row, ownerUserId: row.userId ?? null, collaboratorIds: [] },
      viewer: viewerFromContext(ctx, new Map()),
    };
    if (slot === "session") ctx.sessionAdmission = admission;
    if (slot === "child") ctx.childSessionAdmission = admission;
    return { kind: "not_found" };
  }

  if (mode === "off" && !resolverDecides(mode, row, action)) {
    return { kind: "allowed", legacyPermission: legacyPermissionForAction(action) };
  }

  const memberships =
    (mode === "off" && row.ownerTeamId === null) || !ctx.authorization
      ? new Map<string, TeamRole>()
      : (ctx.sessionMemberships ??= await new TeamMembershipStore(ctx.db).listForUser(
          ctx.authorization.userId
        ));
  const viewer = viewerFromContext(ctx, memberships);
  const accessRow = {
    ...row,
    ownerUserId: row.userId ?? null,
    collaboratorIds: await new SessionCollaboratorStore(ctx.db).listUserIds(sessionId),
  };
  if (slot === "session") ctx.sessionAdmission = { row: accessRow, viewer };
  if (slot === "child") ctx.childSessionAdmission = { row: accessRow, viewer };

  const read: AccessDecision =
    ctx.serviceWorkspaceSessionsOnly && row.ownerTeamId !== null
      ? { allowed: false, reason: "not_member" }
      : checkSessionAccess(viewer, accessRow, "read");
  if (
    !read.allowed &&
    (mode === "on" || (row.visibility === "private" && read.reason === "private"))
  ) {
    return { kind: "not_found" };
  }
  if (read.allowed && read.audit === "session.private_break_glass") {
    await auditPrivateSessionBreakGlass(ctx, sessionId, row.ownerTeamId);
  }

  // The signed route grant authorizes actorless actions; the service resolver only checks visibility.
  const decision = viewer.kind === "service" ? null : checkSessionAccess(viewer, accessRow, action);
  if (resolverDecides(mode, row, action) && decision && !decision.allowed) {
    return { kind: "action_denied", reason: decision.reason };
  }
  if (mode === "shadow") {
    const reason = !read.allowed
      ? read.reason
      : decision && !decision.allowed
        ? decision.reason
        : null;
    if (reason) {
      if (slot === null) recordShadowBatchDenial(ctx, sessionId, reason);
      else ctx.shadowSessionDenial ??= reason;
    }
  }
  return {
    kind: "allowed",
    legacyPermission: resolverDecides(mode, row, action) ? null : legacyPermissionForAction(action),
  };
}
