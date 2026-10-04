import type { SessionViewer } from "@open-inspect/shared";
import { TeamMembershipStore } from "../db/team-memberships";
import type { RequestContext } from "../http/request-context";
import { viewerFromContext } from "./session-admission";

/** Reuse one membership snapshot for owned-resource decisions in a request. */
export async function resourceViewer(ctx: RequestContext): Promise<SessionViewer> {
  const memberships = ctx.authorization
    ? (ctx.sessionMemberships ??= await new TeamMembershipStore(ctx.db).listForUser(
        ctx.authorization.userId
      ))
    : new Map();
  return viewerFromContext(ctx, memberships);
}
