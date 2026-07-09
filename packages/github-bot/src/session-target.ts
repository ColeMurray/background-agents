/**
 * Session launch-target resolution for the GitHub bot (design §13.2).
 *
 * A repository may name a default environment
 * (`repo_metadata.default_environment_id`) so sessions triggered from it open
 * that environment's full workspace instead of a single-repo checkout. The
 * webhook repo remains the fallback: resolution fails open to a repo-bound
 * session whenever the metadata or environment lookup fails, the environment
 * no longer exists, or it no longer contains the trigger repository — the
 * session must always be able to check out the PR under review.
 */

import { z } from "zod";
import type { Env } from "./types";
import type { Logger } from "./logger";

/**
 * Create-session request fields: scalar repo or environment id — the create
 * schema makes the two mutually exclusive.
 */
export type SessionTargetFields =
  | { repoOwner: string; repoName: string }
  | { environmentId: string };

const metadataResponseSchema = z.object({
  metadata: z.object({ defaultEnvironmentId: z.string().optional() }).nullable(),
});

const environmentResponseSchema = z.object({
  environment: z.object({
    id: z.string(),
    repositories: z.array(z.object({ repoOwner: z.string(), repoName: z.string() })),
  }),
});

async function fetchDefaultEnvironmentId(
  env: Env,
  headers: Record<string, string>,
  owner: string,
  repoName: string,
  log: Logger,
  traceId: string
): Promise<string | null> {
  const repo = `${owner}/${repoName}`.toLowerCase();
  let response: Response;
  try {
    response = await env.CONTROL_PLANE.fetch(
      `https://internal/repos/${owner}/${repoName}/metadata`,
      { headers }
    );
  } catch (err) {
    log.warn("target.metadata_fetch_failed", {
      trace_id: traceId,
      repo,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return null;
  }
  if (!response.ok) {
    log.warn("target.metadata_fetch_failed", { trace_id: traceId, repo, status: response.status });
    return null;
  }
  const parsed = metadataResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    log.warn("target.metadata_invalid_response", { trace_id: traceId, repo });
    return null;
  }
  return parsed.data.metadata?.defaultEnvironmentId ?? null;
}

async function fetchEnvironment(
  env: Env,
  headers: Record<string, string>,
  environmentId: string,
  log: Logger,
  traceId: string
): Promise<z.infer<typeof environmentResponseSchema>["environment"] | null> {
  let response: Response;
  try {
    response = await env.CONTROL_PLANE.fetch(`https://internal/environments/${environmentId}`, {
      headers,
    });
  } catch (err) {
    log.warn("target.environment_fetch_failed", {
      trace_id: traceId,
      environment_id: environmentId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return null;
  }
  if (response.status === 404) {
    log.warn("target.environment_not_found", {
      trace_id: traceId,
      environment_id: environmentId,
    });
    return null;
  }
  if (!response.ok) {
    log.warn("target.environment_fetch_failed", {
      trace_id: traceId,
      environment_id: environmentId,
      status: response.status,
    });
    return null;
  }
  const parsed = environmentResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    log.warn("target.environment_invalid_response", {
      trace_id: traceId,
      environment_id: environmentId,
    });
    return null;
  }
  return parsed.data.environment;
}

/**
 * Resolve the launch target for a session triggered from a repository: the
 * repo's default environment when one is configured, still exists, and
 * contains the trigger repo; otherwise the repo itself.
 */
export async function resolveSessionTarget(
  env: Env,
  headers: Record<string, string>,
  owner: string,
  repoName: string,
  log: Logger,
  traceId: string
): Promise<SessionTargetFields> {
  const repoFields = { repoOwner: owner, repoName };

  const environmentId = await fetchDefaultEnvironmentId(
    env,
    headers,
    owner,
    repoName,
    log,
    traceId
  );
  if (!environmentId) return repoFields;

  const environment = await fetchEnvironment(env, headers, environmentId, log, traceId);
  if (!environment) return repoFields;

  const isMember = environment.repositories.some(
    (r) =>
      r.repoOwner.toLowerCase() === owner.toLowerCase() &&
      r.repoName.toLowerCase() === repoName.toLowerCase()
  );
  if (!isMember) {
    log.warn("target.environment_missing_trigger_repo", {
      trace_id: traceId,
      environment_id: environmentId,
      repo: `${owner}/${repoName}`.toLowerCase(),
    });
    return repoFields;
  }

  log.info("target.environment_selected", {
    trace_id: traceId,
    environment_id: environmentId,
    repo: `${owner}/${repoName}`.toLowerCase(),
  });
  return { environmentId };
}
