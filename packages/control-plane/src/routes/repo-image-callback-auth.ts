import { verifyInternalToken } from "../auth/internal";
import type { RepoImageProvider } from "../db/repo-images";
import type { Logger } from "../logger";
import { REPO_IMAGE_CALLBACK_TOKEN_PATTERN } from "../repo-images/auth";
import type { Env } from "../types";
import { error, type RequestContext } from "./shared";

function getBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  return token || null;
}

export function getRepoImageCallbackBearerToken(request: Request): string | null {
  const token = getBearerToken(request);
  if (!token || !REPO_IMAGE_CALLBACK_TOKEN_PATTERN.test(token)) return null;
  return token;
}

export async function requireBuildCallbackAuth(
  request: Request,
  env: Env,
  ctx: RequestContext,
  logger: Logger
): Promise<Response | null> {
  if (!env.INTERNAL_CALLBACK_SECRET) {
    logger.error("repo_image.callback_auth_misconfigured", {
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Internal authentication not configured", 500);
  }

  const authorized = await verifyInternalToken(
    request.headers.get("Authorization"),
    env.INTERNAL_CALLBACK_SECRET
  );

  if (!authorized) {
    logger.warn("repo_image.callback_auth_failed", {
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Unauthorized", 401);
  }

  return null;
}

function requireRepoImageCallbackBearerFormat(
  request: Request,
  ctx: RequestContext,
  logger: Logger
): Response | null {
  if (getRepoImageCallbackBearerToken(request)) return null;

  logger.warn("repo_image.callback_auth_failed", {
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });
  return error("Unauthorized", 401);
}

/**
 * Authenticates Modal callbacks before parsing the body. Provider-session
 * backends only get a bearer-token format gate here; single-use token
 * authorization is completed by RepoImageBuildWorkflow after parsing the
 * provider session id from the callback body.
 */
export async function requireCallbackPreParseGate(
  request: Request,
  env: Env,
  backend: RepoImageProvider,
  ctx: RequestContext,
  logger: Logger
): Promise<Response | null> {
  if (backend === "modal") {
    return requireBuildCallbackAuth(request, env, ctx, logger);
  }

  return requireRepoImageCallbackBearerFormat(request, ctx, logger);
}
