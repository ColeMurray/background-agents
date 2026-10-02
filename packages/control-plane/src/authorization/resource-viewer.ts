import type { SessionViewer } from "@open-inspect/shared";
import { TeamMembershipStore } from "../db/team-memberships";
import type { RequestContext } from "../http/request-context";
import { viewerFromContext } from "./session-admission";

/** Reuse one membership snapshot for owned-resource decisions in a request. */
export async function resourceViewer(
  ctx: RequestContext,
  ownerTeamId?: string | null
): Promise<SessionViewer> {
  const authorization = ctx.authorization;
  const needsMembership =
    authorization !== undefined &&
    ownerTeamId !== null &&
    authorization.role.key !== "owner" &&
    authorization.role.key !== "administrator";
  const memberships = needsMembership
    ? (ctx.sessionMemberships ??= await new TeamMembershipStore(ctx.db).listForUser(
        authorization.userId
      ))
    : new Map();
  return viewerFromContext(ctx, memberships);
}
