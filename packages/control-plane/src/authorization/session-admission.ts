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
import { SessionCollaboratorStore } from "../db/session-collaborators";
import { SessionIndexStore, type SessionEntry } from "../db/session-index";
import type { RequestContext } from "../http/request-context";
import type { Env } from "../types";
import { auditPrivateSessionBreakGlass } from "./request-audit";
import { resourceViewer } from "./resource-viewer";
import { slackPostGate } from "./slack-post-gate";
import {
  legacyPermissionForAction,
  parseTeamsEnforcementMode,
  resolverDecides,
  type TeamsEnforcementMode,
} from "./teams-enforcement";

export function teamsEnforcementMode(ctx: RequestContext, env: Env): TeamsEnforcementMode {
  return (ctx.teamsEnforcementMode ??= parseTeamsEnforcementMode(env.TEAMS_ENFORCEMENT));
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
  return evaluateLoadedSessionAdmission(
    ctx,
    row,
    action,
    mode,
    slot,
    (includeMemberships) => resourceViewer(ctx, includeMemberships),
    () => new SessionCollaboratorStore(ctx.db).listUserIds(sessionId)
  );
}

export interface SessionAdmissionResult {
  sessionId: string;
  row: SessionEntry | null;
  outcome: SessionAdmissionOutcome;
}

/** Bulk reads, ordered decisions. Stopping iteration also stops admission audit side effects. */
export async function* evaluateSessionAdmissions(
  ctx: RequestContext,
  env: Env,
  ids: readonly string[],
  action: SessionAction,
  enforceAlways = false
): AsyncGenerator<SessionAdmissionResult> {
  if (!ids.length) return;
  const mode = enforceAlways ? "on" : teamsEnforcementMode(ctx, env);
  const rows = await new SessionIndexStore(ctx.db).getByIds(ids);
  let collaborators: Promise<ReadonlyMap<string, string[]>> | undefined;
  let viewer: Promise<SessionViewer> | undefined;
  let rollbackViewer: Promise<SessionViewer> | undefined;
  const getViewer = (includeMemberships: boolean) =>
    includeMemberships
      ? (viewer ??= resourceViewer(ctx))
      : (rollbackViewer ??= resourceViewer(ctx, false));
  for (const sessionId of ids) {
    const row = rows.get(sessionId) ?? null;
    const outcome = await evaluateLoadedSessionAdmission(
      ctx,
      row,
      action,
      mode,
      null,
      getViewer,
      async () =>
        (await (collaborators ??= new SessionCollaboratorStore(ctx.db).listForSessions(ids))).get(
          sessionId
        ) ?? []
    );
    yield { sessionId, row, outcome };
  }
}

async function evaluateLoadedSessionAdmission(
  ctx: RequestContext,
  row: SessionEntry | null,
  action: SessionAction,
  mode: TeamsEnforcementMode,
  slot: "session" | "child" | null,
  getViewer: (includeMemberships: boolean) => Promise<SessionViewer>,
  getCollaboratorIds: () => Promise<string[]>
): Promise<SessionAdmissionOutcome> {
  if (!row) return { kind: "not_found" };
  const sessionId = row.id;

  // Publication is narrower than workspace readability, including during rollback.
  if (
    ctx.serviceReadPurpose === "slack-post" &&
    slackPostGate(row, ctx.serviceTeamId ? { teamId: ctx.serviceTeamId } : null)
  ) {
    const admission = {
      row: { ...row, ownerUserId: row.userId ?? null, collaboratorIds: [] },
      viewer: await getViewer(false),
    };
    if (slot === "session") ctx.sessionAdmission = admission;
    if (slot === "child") ctx.childSessionAdmission = admission;
    return { kind: "not_found" };
  }

  if (mode === "off" && !resolverDecides(mode, row, action)) {
    return { kind: "allowed", legacyPermission: legacyPermissionForAction(action) };
  }

  const viewer = await getViewer(!(mode === "off" && row.ownerTeamId === null));
  const accessRow = {
    ...row,
    ownerUserId: row.userId ?? null,
    collaboratorIds: await getCollaboratorIds(),
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
      if (slot === null) (ctx.shadowBatchDenials ??= []).push({ sessionId, reason });
      else ctx.shadowSessionDenial ??= reason;
    }
  }
  return {
    kind: "allowed",
    legacyPermission: resolverDecides(mode, row, action) ? null : legacyPermissionForAction(action),
  };
}
