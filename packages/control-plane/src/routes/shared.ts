/**
 * Shared route primitives used by all route modules.
 */

import type { CorrelationContext } from "../logger";
import type { RequestMetrics } from "../db/instrumented-d1";
import type { Env } from "../types";
import type { Logger } from "../logger";
import {
  createSourceControlProviderFromEnv,
  SourceControlProviderError,
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
 * max_age_seconds for the image-maintenance routes (repo + environment
 * mark-stale/cleanup). Rejecting non-numbers matters: a null that fell
 * through to `null * 1000 = 0` would mark every building row stale or delete
 * every failed row.
 */
export async function parseMaxAgeMs(
  request: Request,
  defaultMs: number
): Promise<number | Response> {
  let body: { max_age_seconds?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  if (body.max_age_seconds === undefined) return defaultMs;
  if (
    typeof body.max_age_seconds !== "number" ||
    !Number.isFinite(body.max_age_seconds) ||
    body.max_age_seconds < 0
  ) {
    return error("max_age_seconds must be a non-negative number", 400);
  }
  return body.max_age_seconds * 1000;
}

/**
 * Raise from a route handler or helper to return an error response with a
 * specific status. Mapped centrally in router.ts's dispatch catch to
 * error(message, status), avoiding `| Response` plumbing in callers.
 */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Create a SourceControlProvider for use in Worker-level route handlers.
 * Cheap to construct (no I/O), so creating per-request is fine.
 */
export function createRouteSourceControlProvider(env: Env): SourceControlProvider {
  return createSourceControlProviderFromEnv(env);
}

export async function resolveInstalledRepo(
  provider: SourceControlProvider,
  repoOwner: string,
  repoName: string
): Promise<RepositoryAccessResult | null> {
  const result = await provider.checkRepositoryAccess({ owner: repoOwner, name: repoName });
  return result;
}

/**
 * Parse the request body as JSON, returning the typed result or an error Response.
 *
 * Usage:
 * ```ts
 * const body = await parseJsonBody<{ secrets: Record<string, string> }>(request);
 * if (body instanceof Response) return body;
 * ```
 */
export async function parseJsonBody<T>(request: Request): Promise<T | Response> {
  try {
    return (await request.json()) as T;
  } catch {
    return error("Invalid JSON body", 400);
  }
}

/**
 * Extract `owner` and `name` named groups from a route match, returning
 * the pair or an error Response when either is missing.
 */
export function extractRepoParams(
  match: RegExpMatchArray
): { owner: string; name: string } | Response {
  const owner = match.groups?.owner;
  const name = match.groups?.name;
  if (!owner || !name) {
    return error("Owner and name are required", 400);
  }
  return { owner, name };
}

/**
 * Resolve a repository via the SCM provider, returning the full
 * {@link RepositoryAccessResult} or raising an HttpError.
 *
 * Handles:
 * - Provider construction
 * - 404 when the repo is not installed
 * - Permanent configuration errors (surfaced as the original message)
 * - Transient / unexpected errors (generic 500)
 */
export async function resolveRepoOrError(
  env: Env,
  owner: string,
  name: string,
  ctx: RequestContext,
  logger: Logger
): Promise<RepositoryAccessResult> {
  let resolved: RepositoryAccessResult | null = null;
  try {
    const provider = createRouteSourceControlProvider(env);
    resolved = await resolveInstalledRepo(provider, owner, name);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error("Failed to resolve repository", {
      error: message,
      repo_owner: owner,
      repo_name: name,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    const isConfigError =
      e instanceof SourceControlProviderError && e.errorType === "permanent" && !e.httpStatus;
    throw new HttpError(isConfigError ? message : "Failed to resolve repository", 500);
  }
  if (!resolved) {
    throw new HttpError("Repository is not installed for the GitHub App", 404);
  }
  return resolved;
}
