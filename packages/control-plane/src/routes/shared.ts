/**
 * Shared route primitives used by all route modules.
 */

import type { CorrelationContext } from "../logger";
import type { RequestMetrics } from "../db/instrumented-d1";
import type { Env } from "../types";
import { getGitHubAppConfig } from "../auth/github-app";
import {
  createSourceControlProvider,
  resolveScmProviderFromEnv,
  type SourceControlProvider,
  type RepositoryAccessResult,
} from "../source-control";

/**
 * Request context with correlation IDs and per-request metrics.
 */
export type RequestContext = CorrelationContext & {
  metrics: RequestMetrics;
  /** Worker ExecutionContext for waitUntil (background tasks). */
  executionCtx?: ExecutionContext;
};

/**
 * Route configuration.
 */
export interface Route {
  method: string;
  pattern: RegExp;
  handler: (
    request: Request,
    env: Env,
    match: RegExpMatchArray,
    ctx: RequestContext
  ) => Promise<Response>;
}

/**
 * Parse route pattern into regex.
 */
export function parsePattern(pattern: string): RegExp {
  const regexPattern = pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)");
  return new RegExp(`^${regexPattern}$`);
}

/**
 * Create JSON response.
 */
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Create error response.
 */
export function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

/**
 * Create a SourceControlProvider for use in Worker-level route handlers.
 * Cheap to construct (no I/O), so creating per-request is fine.
 */
export function createRouteSourceControlProvider(env: Env): SourceControlProvider {
  const appConfig = getGitHubAppConfig(env);
  const provider = resolveScmProviderFromEnv(env.SCM_PROVIDER);
  return createSourceControlProvider({
    provider,
    github: {
      appConfig: appConfig ?? undefined,
      kvCache: env.REPOS_CACHE,
    },
  });
}

export async function resolveInstalledRepo(
  provider: SourceControlProvider,
  repoOwner: string,
  repoName: string
): Promise<RepositoryAccessResult | null> {
  return provider.checkRepositoryAccess({ owner: repoOwner, name: repoName });
}
