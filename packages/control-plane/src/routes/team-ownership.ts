/**
 * Team scoping shared by creation routes (which team will own the new resource) and catalog
 * routes (which resources a team's sessions may launch with).
 */

import { isWorkspaceAdmin } from "@open-inspect/shared/rbac";
import type { Team } from "@open-inspect/shared/types/teams";
import { parseChannelScope } from "../authorization/channel-scope";
import { auditRouteAuthorizationDecision } from "../authorization/request-audit";
import { TeamChannelBindingStore } from "../db/team-channel-bindings";
import { TeamMembershipStore } from "../db/team-memberships";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import { TeamSettingsStore } from "../db/team-settings";
import { TeamStore } from "../db/teams";
import { error, json } from "../http/responses";
import type { RequestContext } from "../http/request-context";

export type TeamRepositoryGrants = Awaited<ReturnType<TeamRepositoryGrantStore["listForTeam"]>>;

/** Null is unscoped; an explicit workspace scope must not include other teams' resources. */
export async function resolveCatalogScope(
  request: Request,
  ctx: RequestContext,
  catalogTeamId: string | null,
  path: string
): Promise<{ teamId: string | null; grants: TeamRepositoryGrants | null } | null | Response> {
  const query = new URL(request.url).searchParams;
  const channels = query.getAll("channel");
  if (channels.length > 0) {
    const refusal = { error: "Slack channel scope denied", code: "slack_channel_scope_denied" };
    const scope = channels.length === 1 ? parseChannelScope(channels[0]) : null;
    if (!scope || scope.provider !== "slack" || query.has("teamId")) return json(refusal, 400);
    if (
      ctx.principal?.kind !== "service" ||
      ctx.principal.service !== "slack-bot" ||
      !ctx.authorization
    ) {
      return json(refusal, 403);
    }
    try {
      const teamId =
        (await new TeamChannelBindingStore(ctx.db).get("slack", scope.externalId))?.teamId ?? null;
      const grants = teamId === null ? null : await admitTeamCatalog(request, ctx, teamId, path);
      return grants instanceof Response ? grants : { teamId, grants };
    } catch {
      return json(refusal, 503);
    }
  }
  if (query.getAll("teamId").length > 1) return error("Invalid teamId", 400);
  if (
    query.has("teamId") &&
    ctx.principal?.kind === "service" &&
    ctx.principal.service === "slack-bot"
  ) {
    return denyTeamCatalog(request, ctx, catalogTeamId, path);
  }
  if (catalogTeamId === null) return null;
  const grants = await admitTeamCatalog(request, ctx, catalogTeamId, path);
  return grants instanceof Response ? grants : { teamId: catalogTeamId, grants };
}

export function teamRequiredResponse(): Response {
  return json({ error: "A team is required", code: "team_required" }, 400);
}

/**
 * Validate the owner team named when creating a resource: the workspace may require one, and
 * archived teams accept no new resources. Resolves to null for workspace ownership. Callers
 * still decide whether the creator may act for the team.
 */
export async function resolveCreationOwnerTeam(
  ctx: RequestContext,
  ownerTeamId: string | null
): Promise<Team | null | Response> {
  if (ownerTeamId === null) {
    return (await new TeamSettingsStore(ctx.db).get()).requireTeamOnCreate
      ? teamRequiredResponse()
      : null;
  }
  return resolveActiveTeam(ctx, ownerTeamId);
}

/** Resolve a team that will own or keep owning a resource; archived teams accept no changes. */
export async function resolveActiveTeam(
  ctx: RequestContext,
  teamId: string
): Promise<Team | Response> {
  const team = await new TeamStore(ctx.db).getById(teamId);
  if (!team) return error("Team not found", 404);
  if (team.archivedAt !== null) {
    return json(
      { error: "Team archived", code: "team_archived", reason_code: "team_archived" },
      409
    );
  }
  return team;
}

/**
 * Admit a team's session catalog and return its repository grants. The team must be
 * active and the caller a member or workspace admin; hidden teams are audited and answered
 * like missing ones.
 */
export async function admitTeamCatalog(
  request: Request,
  ctx: RequestContext,
  catalogTeamId: string,
  path: string
): Promise<TeamRepositoryGrants | Response> {
  const authorization = ctx.authorization;
  const roleKey = authorization?.role.key;
  const allowed =
    !!authorization &&
    (await new TeamStore(ctx.db).isActive(catalogTeamId)) &&
    (isWorkspaceAdmin(roleKey) ||
      (ctx.sessionMemberships ??= await new TeamMembershipStore(ctx.db).listForUser(
        authorization.userId
      )).has(catalogTeamId));
  if (!allowed) {
    return denyTeamCatalog(request, ctx, catalogTeamId, path);
  }
  return new TeamRepositoryGrantStore(ctx.db).listForTeam(catalogTeamId);
}

async function denyTeamCatalog(
  request: Request,
  ctx: RequestContext,
  teamId: string | null,
  path: string
): Promise<Response> {
  const response = error("Team not found", 404);
  await auditRouteAuthorizationDecision({
    ctx,
    method: request.method,
    path,
    response,
    teamId,
    decision: {
      kind: "denied",
      reasonCode: "team_not_visible",
      reason: "Team not found",
      requirements: [{ kind: "team", teamIdParam: "teamId", need: "member" }],
      effectivePermissions: [],
    },
  });
  return response;
}
