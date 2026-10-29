import { Hono } from "hono";
import { z } from "zod";
import { UserStore } from "../db/user-store";
import { TeamStore } from "../db/teams";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { error, GITHUB_SERVICE_ROUTE, json, requirePermission, type RouteContext } from "./shared";

const positiveIntegerSchema = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().positive());
const querySchema = z.object({
  repositoryId: positiveIntegerSchema,
  pullNumber: positiveIntegerSchema.optional(),
  sender: z
    .string()
    .regex(/^github:\d+$/)
    .optional(),
});
const teamIdRowSchema = z.object({ team_id: z.string().nullable() });
const WORKSPACE_ROUTE = { teamId: null, via: "workspace" } as const;

async function handleGitHubRoute(
  request: Request,
  _env: Env,
  _params: Record<string, string>,
  ctx: RouteContext<{ kind: "service" }>
): Promise<Response> {
  if (ctx.principal.service !== "github-bot" || ctx.principal.actor !== null) {
    return error("Actorless github-bot authentication required", 403);
  }

  const query = new URL(request.url).searchParams;
  if (["repositoryId", "pullNumber", "sender"].some((key) => query.getAll(key).length > 1)) {
    return error("Invalid GitHub route query", 400);
  }
  const parsed = querySchema.safeParse({
    repositoryId: query.get("repositoryId") ?? undefined,
    pullNumber: query.get("pullNumber") ?? undefined,
    sender: query.get("sender") ?? undefined,
  });
  if (!parsed.success) return error("Invalid GitHub route query", 400);
  const { repositoryId, pullNumber, sender } = parsed.data;

  if (pullNumber !== undefined) {
    // This routing hint grants no session access, including for private PR sessions.
    const linked = teamIdRowSchema.nullable().parse(
      await ctx.db
        .prepare(
          `SELECT s.owner_team_id AS team_id FROM session_pull_requests pr
           JOIN sessions s ON s.id = pr.session_id
           WHERE pr.repository_external_id = ? AND pr.pr_number = ?`
        )
        .bind(String(repositoryId), pullNumber)
        .first()
    );
    if (linked) return json({ teamId: linked.team_id, via: "pull_request_session" });
  }
  if (!sender) return json(WORKSPACE_ROUTE);

  const identity = await new UserStore(ctx.db).getIdentity(
    "github",
    sender.slice("github:".length)
  );
  if (!identity) return json(WORKSPACE_ROUTE);
  const { userId } = z.object({ userId: z.string().min(1) }).parse(identity);
  const teams = await new TeamStore(ctx.db).list({ forUserId: userId });
  const grantedTeams = new Set(
    await new TeamRepositoryGrantStore(ctx.db).listTeamsForRepository(repositoryId)
  );
  const eligibleTeams = teams.filter((team) => grantedTeams.has(team.id));
  if (eligibleTeams.length === 0) return json(WORKSPACE_ROUTE);
  if (eligibleTeams.length === 1) {
    return json({ teamId: eligibleTeams[0].id, via: "sender_membership" });
  }

  const recent = teamIdRowSchema.nullable().parse(
    await ctx.db
      .prepare(
        `SELECT s.owner_team_id AS team_id FROM sessions s
         JOIN teams t ON t.id = s.owner_team_id AND t.archived_at IS NULL
         JOIN team_memberships m ON m.team_id = t.id AND m.user_id = s.user_id
         WHERE s.user_id = ?
           AND EXISTS (SELECT 1 FROM team_repository_grants g WHERE g.team_id = t.id
                       AND (g.grant_kind = 'installation' OR
                            (g.grant_kind = 'repository' AND g.repo_external_id = ?)))
           AND EXISTS (SELECT 1 FROM session_repositories sr
                       WHERE sr.session_id = s.id AND sr.repo_id = ?)
          ORDER BY s.created_at DESC, s.id DESC LIMIT 1`
      )
      .bind(userId, repositoryId, repositoryId)
      .first()
  );
  return json(recent ? { teamId: recent.team_id, via: "sender_membership" } : WORKSPACE_ROUTE);
}

export const githubRoutingRoutes = new Hono<ControlPlaneHonoEnv>();

githubRoutingRoutes.get(
  "/github/route",
  admit({
    ...GITHUB_SERVICE_ROUTE,
    authorization: requirePermission("repositories.read", {
      actorlessGrants: [{ service: "github-bot" }],
    }),
    cacheControl: "private, no-store",
    // Admission runs this before enrolling an actor on permission-bearing routes.
    serviceActorClaims: async () => ({
      kind: "rejected",
      response: error("Actorless github-bot authentication required", 403),
    }),
  }),
  (c) => dispatch(c, handleGitHubRoute)
);
