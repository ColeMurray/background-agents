import {
  checkSessionAccess,
  type SessionAccessRow,
  type SessionViewer,
} from "@open-inspect/shared";
import type { TeamRole } from "@open-inspect/shared/types/teams";
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
  actorId: string,
  targetSessionId: string,
  options: { sourceSessionId: string }
): Promise<CrossSessionTargetDecision> {
  if (targetSessionId === options.sourceSessionId) {
    return { kind: "denied", reason: "A session cannot message itself" };
  }

  const target = await new SessionIndexStore(db).get(targetSessionId);
  if (!target) return { kind: "not_found" };
  if (target.status === "archived" || target.status === "cancelled") {
    return { kind: "denied", reason: "The target session is closed" };
  }

  let authorization;
  try {
    authorization = await new AuthorizationService(db).getEffectiveAuthorization(actorId);
  } catch {
    return { kind: "denied", reason: "The actor has no active workspace role" };
  }
  if (authorization.suspendedAt !== null) {
    return { kind: "denied", reason: "The actor is suspended" };
  }

  const memberships = await new TeamMembershipStore(db).listForUser(actorId);
  const viewer: SessionViewer = {
    kind: "user",
    userId: authorization.userId,
    roleKey: authorization.role.key,
    permissions: authorization.permissions,
    suspended: false,
    memberships,
  };
  const row: SessionAccessRow = {
    id: target.id,
    ownerUserId: target.userId ?? null,
    ownerTeamId: target.ownerTeamId,
    visibility: target.visibility,
    collaboratorIds: await new SessionCollaboratorStore(db).listUserIds(target.id),
  };

  const decision = checkSessionAccess(viewer, row, "collaborate");
  if (!decision.allowed) {
    // The resolver owns team-owned actions and private sessions. When it does
    // not, the legacy workspace permission decides.
    if (!resolverDecides(mode, row, "collaborate")) {
      const legacy = viewer.kind === "user" ? viewer.permissions : [];
      if (!legacy.includes("sessions.collaborate")) {
        return { kind: "denied", reason: "The actor may not collaborate in the target session" };
      }
    } else {
      return { kind: "denied", reason: "The actor may not collaborate in the target session" };
    }
  }
  return { kind: "allowed", row, actorId: authorization.userId };
}

/** The team memberships a viewer holds, for callers that need them directly. */
export type { TeamRole };
