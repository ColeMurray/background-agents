/**
 * Shared route primitives used by all route modules.
 */

import type { CorrelationContext } from "../logger";
import type { RequestMetrics } from "../db/instrumented-d1";
import type { Env } from "../types";
import { getGitHubAppConfig, getInstallationRepository } from "../auth/github-app";
import { getBitbucketRepository, getBitbucketRepositoryWithOAuth } from "../auth/bitbucket";
import { resolveScmProviderFromEnv, type SourceControlProviderName } from "../source-control";

function stableRepoIdFromFullName(fullName: string): number {
  let hash = 0;
  for (let i = 0; i < fullName.length; i++) {
    hash = (hash * 31 + fullName.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) + 1;
}

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

export async function resolveInstalledRepo(
  env: Env,
  repoOwner: string,
  repoName: string,
  providerOverride?: SourceControlProviderName,
  scmToken?: string
): Promise<{ repoId: number; repoOwner: string; repoName: string } | null> {
  const provider = providerOverride ?? resolveScmProviderFromEnv(env.SCM_PROVIDER);

  if (provider === "bitbucket") {
    if (scmToken) {
      const repo = await getBitbucketRepositoryWithOAuth(scmToken, repoOwner, repoName);
      if (!repo) {
        return null;
      }
      return {
        repoId: stableRepoIdFromFullName(repo.fullName.toLowerCase()),
        repoOwner: repoOwner.toLowerCase(),
        repoName: repoName.toLowerCase(),
      };
    }

    if (!env.BITBUCKET_BOT_USERNAME || !env.BITBUCKET_BOT_APP_PASSWORD) {
      throw new Error("Bitbucket bot credentials not configured and no user token provided");
    }

    const repo = await getBitbucketRepository(
      env.BITBUCKET_BOT_USERNAME,
      env.BITBUCKET_BOT_APP_PASSWORD,
      repoOwner,
      repoName
    );
    if (!repo) {
      return null;
    }
    return {
      repoId: stableRepoIdFromFullName(repo.fullName.toLowerCase()),
      repoOwner: repoOwner.toLowerCase(),
      repoName: repoName.toLowerCase(),
    };
  }

  const appConfig = getGitHubAppConfig(env);
  if (!appConfig) {
    throw new Error("GitHub App not configured");
  }

  const repo = await getInstallationRepository(appConfig, repoOwner, repoName, env);
  if (!repo) {
    return null;
  }

  return {
    repoId:
      typeof repo.id === "number"
        ? repo.id
        : stableRepoIdFromFullName(`${repo.owner}/${repo.name}`.toLowerCase()),
    repoOwner: repoOwner.toLowerCase(),
    repoName: repoName.toLowerCase(),
  };
}
