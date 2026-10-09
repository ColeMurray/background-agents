/**
 * Sandbox-authenticated broker for the optional reviewer GitHub App.
 * The review POST alone uses this App, so PRs opened by the main App can be
 * approved. Other GitHub calls retain their existing credential.
 *
 * Mint on demand (with the installation-token cache), not at sandbox launch:
 * a review can outlive a token. Admission binds the sandbox to params.id and
 * no-store prevents downstream caching of the write credential.
 *
 * Admission alone would hand the token to any session's sandbox, so the handler
 * also requires the session to have been spawned by the GitHub bot: the only
 * spawner whose prompt submits reviews. `spawn_source` comes from the
 * authenticated creating principal, not from anything the sandbox controls.
 *
 * The token covers only the repository the sandbox names as the one under
 * review, and only when that repository is a member of the session within the
 * owner team's current grants. Nothing persisted records which member is under
 * review (an environment launch orders members by the environment), and
 * requesting the session's other repositories would fail wherever the
 * reviewer App is not installed on them.
 */

import { resolveAppName } from "@open-inspect/shared/app-name";
import { parseRepositoryFullName } from "@open-inspect/shared/types/repositories";
import { Hono } from "hono";
import { getCachedInstallationToken, getGitHubReviewerAppConfig } from "../auth/github-app";
import { SessionIndexStore } from "../db/session-index";
import { SessionRepositoryStore } from "../db/session-repositories";
import { createLogger } from "../logger";
import { readCachedInstallationRepositories } from "../repos/cache";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { resolveRepositoryCredentialScope } from "../source-control/repository-scope";
import type { Env } from "../types";
import {
  error,
  json,
  NO_AUTHORIZATION,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  type SandboxRouteContext,
} from "./shared";

const logger = createLogger("router:github-reviewer-token");

export const githubReviewerTokenRoutes = new Hono<ControlPlaneHonoEnv>();

async function handleReviewerToken(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: SandboxRouteContext
): Promise<Response> {
  const reviewerAppConfig = getGitHubReviewerAppConfig(env);
  if (!reviewerAppConfig) {
    return error("No reviewer app configured", 404);
  }

  const session = await new SessionIndexStore(ctx.db).get(params.id);
  if (session?.spawnSource !== "github-bot") {
    logger.warn("review_token.session_not_eligible", {
      event: "review_token.session_not_eligible",
      session_id: params.id,
      spawn_source: session?.spawnSource ?? null,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Reviewer token is only issued to GitHub bot sessions", 403);
  }

  const requested = parseRepositoryFullName(
    new URL(request.url).searchParams.get("repository") ?? ""
  );
  if (!requested) {
    return error("repository must name the reviewed repository as owner/name", 400);
  }

  const members = await new SessionRepositoryStore(ctx.db).listRepositoryIds(params.id);
  const repositories = members.length
    ? members
    : session.repoOwner && session.repoName
      ? [{ repoOwner: session.repoOwner, repoName: session.repoName, repoId: null }]
      : [];
  const reviewed = repositories.find(
    (repository) =>
      repository.repoOwner.toLowerCase() === requested.repoOwner.toLowerCase() &&
      repository.repoName.toLowerCase() === requested.repoName.toLowerCase()
  );
  if (!reviewed) {
    logger.warn("review_token.repository_not_in_session", {
      event: "review_token.repository_not_in_session",
      session_id: params.id,
      repository: `${requested.repoOwner}/${requested.repoName}`.toLowerCase(),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Reviewer token is only issued for a repository of this session", 403);
  }

  try {
    const scope = await resolveRepositoryCredentialScope(
      ctx.db,
      [reviewed],
      session.ownerTeamId,
      () => readCachedInstallationRepositories(env)
    );
    const token = await getCachedInstallationToken(
      reviewerAppConfig,
      { cacheStore: env.REPOS_CACHE, userAgent: resolveAppName(env) },
      { scope }
    );
    return json({ token });
  } catch (cause) {
    logger.error("review_token.mint_failed", {
      event: "review_token.mint_failed",
      session_id: params.id,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      error: cause instanceof Error ? cause : String(cause),
    });
    return error("Failed to mint reviewer token", 502);
  }
}

githubReviewerTokenRoutes.get(
  "/sessions/:id/review-token",
  admit({
    ...SCM_AGNOSTIC_SANDBOX_ROUTE,
    cacheControl: "no-store",
    authorization: NO_AUTHORIZATION,
  }),
  (c) => dispatch(c, handleReviewerToken)
);
