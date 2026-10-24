import {
  checkSessionAccess,
  type SessionAccessRow,
  type SessionViewer,
} from "@open-inspect/shared";

type UserViewer = Extract<SessionViewer, { kind: "user" }>;
import { AuthorizationService } from "../authorization/service";
import { resolverDecides, type TeamsEnforcementMode } from "../authorization/teams-enforcement";
import { SessionCollaboratorStore } from "../db/session-collaborators";
import { SessionIndexStore } from "../db/session-index";
import { TeamMembershipStore } from "../db/team-memberships";
import type { SqlDatabase } from "../db/sql-database";

export type CrossSessionTargetDecision =
  | { kind: "allowed"; row: SessionAccessRow; actorId: string }
  | { kind: "not_found" }
  | { kind: "denied"; reason: string };

export interface CrossSessionTargetRequest {
  /** The session the message comes from. It is never the current runtime. */
  sourceSessionId: string;
  /** The human whose authority carries the message. */
  actorId: string;
  /** The session the message is going to. */
  targetSessionId: string;
}

/**
 * Resolve whether one actor may hand a message to one target session.
 *
 * The authority is read from D1 at the moment of the call, never from a cache,
 * so a suspended user, a removed collaborator, or a lost team membership takes
 * effect immediately. The rules are the canonical session rules: the actor
 * needs the same `collaborate` authority on the target that they would need
 * to post in it themselves. An administrator who may break-glass *read* a
 * private session may not send into it.
 */
export async function evaluateCrossSessionTarget(
  db: SqlDatabase,
  mode: TeamsEnforcementMode,
  request: CrossSessionTargetRequest
): Promise<CrossSessionTargetDecision> {
  if (request.targetSessionId === request.sourceSessionId) {
    return { kind: "denied", reason: "A session cannot message itself" };
  }

  const target = await new SessionIndexStore(db).get(request.targetSessionId);
  if (!target) return { kind: "not_found" };
  if (target.status === "archived" || target.status === "cancelled") {
    return { kind: "denied", reason: "The target session is closed" };
  }

  const viewer = await resolveViewer(db, request.actorId);
  if (!viewer) {
    return { kind: "denied", reason: "The actor has no active workspace role" };
  }
  if (viewer.suspended) {
    return { kind: "denied", reason: "The actor is suspended" };
  }

  const ownerLiveness = await resolveOwnerLiveness(db, target.userId ?? null, target.ownerTeamId);
  if (ownerLiveness === "suspended") {
    return { kind: "denied", reason: "The target session's owner is suspended" };
  }
  if (ownerLiveness === "archived_team") {
    return { kind: "denied", reason: "The target session's team is archived" };
  }

  const row = await accessRow(
    db,
    target.id,
    target.userId ?? null,
    target.ownerTeamId,
    target.visibility
  );
  const decision = checkSessionAccess(viewer, row, "collaborate");
  if (!decision.allowed) {
    // The resolver owns team-owned actions and private sessions. When it does
    // not, the legacy workspace permission decides.
    if (!resolverDecides(mode, row, "collaborate")) {
      if (!viewer.permissions.includes("sessions.collaborate")) {
        return { kind: "denied", reason: "The actor may not collaborate in the target session" };
      }
    } else {
      return { kind: "denied", reason: "The actor may not collaborate in the target session" };
    }
  }
  return { kind: "allowed", row, actorId: request.actorId };
}

export type CrossSessionSourceDecision = { kind: "allowed" } | { kind: "denied"; reason: string };

/**
 * Resolve whether the actor still holds authority in the source session.
 *
 * The source's own authority matters as much as the target's: an actor who
 * lost access to the session may not keep using it to reach other sessions.
 */
export async function evaluateCrossSessionSource(
  db: SqlDatabase,
  mode: TeamsEnforcementMode,
  request: { sourceSessionId: string; actorId: string }
): Promise<CrossSessionSourceDecision> {
  const source = await new SessionIndexStore(db).get(request.sourceSessionId);
  if (!source) return { kind: "denied", reason: "The source session no longer exists" };
  if (source.status === "archived" || source.status === "cancelled") {
    return { kind: "denied", reason: "The source session is closed" };
  }
  const viewer = await resolveViewer(db, request.actorId);
  if (!viewer) return { kind: "denied", reason: "The actor has no active workspace role" };
  if (viewer.suspended) return { kind: "denied", reason: "The actor is suspended" };
  const row = await accessRow(
    db,
    source.id,
    source.userId ?? null,
    source.ownerTeamId,
    source.visibility
  );
  const decision = checkSessionAccess(viewer, row, "collaborate");
  if (!decision.allowed && resolverDecides(mode, row, "collaborate")) {
    return { kind: "denied", reason: "The actor may no longer collaborate in the source session" };
  }
  if (!decision.allowed && !viewer.permissions.includes("sessions.collaborate")) {
    return { kind: "denied", reason: "The actor may no longer collaborate in the source session" };
  }
  return { kind: "allowed" };
}

/** The actor's current workspace authority, read now. */
async function resolveViewer(db: SqlDatabase, actorId: string): Promise<UserViewer | null> {
  let authorization;
  try {
    authorization = await new AuthorizationService(db).getEffectiveAuthorization(actorId);
  } catch {
    return null;
  }
  const memberships = await new TeamMembershipStore(db).listForUser(actorId);
  return {
    kind: "user",
    userId: authorization.userId,
    roleKey: authorization.role.key,
    permissions: authorization.permissions,
    suspended: authorization.suspendedAt !== null,
    memberships,
  };
}

/** The access row of one session, with its collaborators read now. */
async function accessRow(
  db: SqlDatabase,
  sessionId: string,
  ownerUserId: string | null,
  ownerTeamId: string | null,
  visibility: SessionAccessRow["visibility"]
): Promise<SessionAccessRow> {
  return {
    id: sessionId,
    ownerUserId,
    ownerTeamId,
    visibility,
    collaboratorIds: await new SessionCollaboratorStore(db).listUserIds(sessionId),
  };
}

/**
 * Whether the account or team behind a session is still standing.
 *
 * A session whose owner is suspended, or whose team is archived, does not
 * accept new agent-originated messages.
 */
async function resolveOwnerLiveness(
  db: SqlDatabase,
  ownerUserId: string | null,
  ownerTeamId: string | null
): Promise<"ok" | "suspended" | "archived_team"> {
  if (ownerUserId) {
    const owner = await db
      .prepare("SELECT suspended_at FROM users WHERE id = ?")
      .bind(ownerUserId)
      .first<{ suspended_at: number | null }>();
    if (!owner) return "suspended";
    if (owner.suspended_at !== null) return "suspended";
  }
  if (ownerTeamId) {
    const team = await db
      .prepare("SELECT archived_at FROM teams WHERE id = ?")
      .bind(ownerTeamId)
      .first<{ archived_at: number | null }>();
    if (team?.archived_at) return "archived_team";
  }
  return "ok";
}
