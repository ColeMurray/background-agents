import type { SessionViewer } from "@open-inspect/shared";
import type { EffectiveAuthorization } from "@open-inspect/shared/rbac";
import type { TeamRole } from "@open-inspect/shared/types/teams";
import type { SqlDatabase } from "../db/sql-database";
import { TeamMembershipStore } from "../db/team-memberships";
import type { RequestContext } from "../http/request-context";
import { AuthorizationError, AuthorizationService } from "./service";

export function userViewer(
  authorization: EffectiveAuthorization,
  memberships: ReadonlyMap<string, TeamRole>
): Extract<SessionViewer, { kind: "user" }> {
  return {
    kind: "user",
    userId: authorization.userId,
    roleKey: authorization.role.key,
    permissions: authorization.permissions,
    suspended: authorization.suspendedAt !== null,
    memberships,
  };
}

/** Reuse request memberships; rollback skips must not populate the cache. */
export async function resourceViewer(
  ctx: RequestContext,
  includeMemberships = true
): Promise<SessionViewer> {
  const authorization = ctx.authorization;
  if (!authorization) {
    if (ctx.principal?.kind === "service" && !ctx.principal.actor)
      return { kind: "service", teamId: ctx.serviceTeamId ?? null };
    throw new Error("Missing request authorization");
  }
  const memberships = includeMemberships
    ? (ctx.sessionMemberships ??= await new TeamMembershipStore(ctx.db).listForUser(
        authorization.userId
      ))
    : (ctx.sessionMemberships ?? new Map());
  return userViewer(authorization, memberships);
}

/** Resolve a named user live; denials are distinct from infrastructure failures. */
export async function viewerForUser(
  db: SqlDatabase,
  userId: string,
  includeMemberships = true
): Promise<{
  authorization: EffectiveAuthorization;
  viewer: Extract<SessionViewer, { kind: "user" }>;
} | null> {
  try {
    const authorization = await new AuthorizationService(db).getEffectiveAuthorization(userId);
    const memberships =
      includeMemberships && authorization.suspendedAt === null
        ? await new TeamMembershipStore(db).listForUser(authorization.userId)
        : new Map<string, TeamRole>();
    return { authorization, viewer: userViewer(authorization, memberships) };
  } catch (cause) {
    if (cause instanceof AuthorizationError) return null;
    throw cause;
  }
}
