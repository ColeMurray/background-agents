import {
  checkSessionAccess,
  type SessionAccessRow,
  type SessionAction,
} from "@open-inspect/shared";
import { AuthorizationService } from "../authorization/service";
import { SessionCollaboratorStore } from "../db/session-collaborators";
import { TeamMembershipStore } from "../db/team-memberships";
import type { SqlDatabase } from "../db/sql-database";

/**
 * Whether the author of a turn may still act.
 *
 * A harness with no sandbox has no containment. The only thing that stops a
 * suspended user, or a user who has been removed from the team, from
 * finishing a turn is a check — and upstream makes that check **once**, at
 * admission, because the sandbox keeps the agent inside the box afterwards.
 * A harness that runs in the Durable Object has no box, so the check has to be
 * made again, at the moment of each action, from the database as it stands
 * now.
 *
 * This is the harness-neutral form of the check the sandbox principal gets in
 * `routes/session-children.ts`: the same classes, the same rules, the same
 * fresh reads. It names no harness.
 */

export type TurnAuthorDecision =
  { readonly kind: "allowed" } | { readonly kind: "denied"; readonly reason: string };

export interface TurnAuthorAuthorityOptions {
  readonly db: SqlDatabase;
  /** The action the author wants to take on the session. */
  readonly action: SessionAction;
}

export interface TurnAuthorRequest {
  /** The session the turn belongs to. */
  readonly sessionId: string;
  /** The author of the turn. */
  readonly userId: string;
  /** The session's access row. */
  readonly sessionRow: {
    readonly id: string;
    readonly ownerUserId: string | null;
    readonly ownerTeamId: string | null;
    readonly visibility: SessionAccessRow["visibility"];
  };
}

/**
 * Resolve whether the turn's author may still act on the session.
 *
 * The authority is read from D1 at the moment of the call, never from a
 * cache, so a suspended user, a removed collaborator, or a lost team
 * membership takes effect immediately.
 */
export async function evaluateTurnAuthor(
  options: TurnAuthorAuthorityOptions,
  request: TurnAuthorRequest
): Promise<TurnAuthorDecision> {
  const viewer = await readCurrentViewer(options.db, request.userId);
  if (!viewer) {
    return { kind: "denied", reason: "The turn's author has no active workspace role" };
  }
  if (viewer.suspended) {
    return { kind: "denied", reason: "The turn's author is suspended" };
  }

  const row: SessionAccessRow = {
    id: request.sessionRow.id,
    ownerUserId: request.sessionRow.ownerUserId,
    ownerTeamId: request.sessionRow.ownerTeamId,
    visibility: request.sessionRow.visibility,
    collaboratorIds: await new SessionCollaboratorStore(options.db).listUserIds(request.sessionId),
  };
  const decision = checkSessionAccess(viewer, row, options.action);
  if (!decision.allowed) {
    return { kind: "denied", reason: "The turn's author may no longer act on this session" };
  }
  return { kind: "allowed" };
}

/** The author's current workspace authority, read now. */
async function readCurrentViewer(
  db: SqlDatabase,
  userId: string
): Promise<Extract<Parameters<typeof checkSessionAccess>[0], { kind: "user" }> | null> {
  let authorization;
  try {
    authorization = await new AuthorizationService(db).getEffectiveAuthorization(userId);
  } catch {
    return null;
  }
  const memberships = await new TeamMembershipStore(db).listForUser(userId);
  return {
    kind: "user",
    userId: authorization.userId,
    roleKey: authorization.role.key,
    permissions: authorization.permissions,
    suspended: authorization.suspendedAt !== null,
    memberships,
  };
}
