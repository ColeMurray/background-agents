/**
 * Shared route primitives used by all route modules.
 */

import { decodeRepositoryPathSegments } from "@open-inspect/shared/types/repositories";
import type { CorrelationContext } from "../logger";
import type { AuthenticationContext, Principal } from "../auth/principal";
import type { RequestMetrics } from "../db/instrumented-d1";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";
import type { Logger } from "../logger";
import type { BackgroundTasks } from "../platform-ports";
import type { BetterAuthRuntime, UserAuthRuntime } from "../auth/user/runtime";
import type {
  EffectiveAuthorization,
  PermissionId,
  ScopedPermissionStem,
} from "@open-inspect/shared/rbac";
import type { ServiceName } from "@open-inspect/shared/service-auth";
import {
  createSourceControlProviderFromEnv,
  SourceControlProviderError,
  type SourceControlProvider,
  type RepositoryAccessResult,
  type SourceControlProviderName,
} from "../source-control";

/** Request-scoped dependencies, identity, and resolved authorization state. */
export type RequestContext = CorrelationContext & {
  metrics: RequestMetrics;
  /**
   * The request's database handle (the DB binding wrapped with query
   * instrumentation). Route handlers must use this instead of the raw binding
   * so every query is timed — an ESLint rule forbids `.DB` access under
   * src/routes and src/webhooks.
   */
  db: SqlDatabase;
  /** Request-scoped capability for scheduling background tasks. */
  executionCtx: BackgroundTasks;
  /** Lazy runtime dependency used by user-session authentication and credential access. */
  getUserAuth?: () => BetterAuthRuntime;
  /** Lazy normalized auth runtime used by server-only authentication composition routes. */
  getUserAuthRuntime?: () => UserAuthRuntime;
  /**
   * The request's verified principal. Absent only on public routes and CORS
   * preflights — every authenticated request carries one.
   */
  principal?: Principal;
  /** Authentication provenance, separate from the principal being authorized. */
  authentication?: AuthenticationContext;
  /** Effective human authorization loaded once by the router for this request. */
  authorization?: EffectiveAuthorization;
};

/** Route matching, authorization, and handler configuration. */
export interface RouteDefinition<Context extends RequestContext = RequestContext> {
  method: string;
  pattern: RegExp;
  /** Authorization policy enforced before the handler runs. */
  authorization: RouteAuthorization;
  cacheControl?: "no-store" | "private, no-store";
  handler: (request: Request, env: Env, match: RegExpMatchArray, ctx: Context) => Promise<Response>;
}

/** One permission or resource-admission requirement for an active user. */
export type RouteAuthorizationRequirement =
  | { kind: "permission"; permission: PermissionId }
  | { kind: "scoped-permission"; stem: ScopedPermissionStem }
  | {
      kind: "automation";
      operation: "manage" | "trigger";
      automationIdParam: string;
    };

type BotServiceName = Exclude<ServiceName, "web">;

/** Narrow route grant for a trusted service without an acting user. */
export interface ActorlessServiceGrant {
  service: BotServiceName;
  pathParams?: Readonly<Record<string, string>>;
}

type ServiceAuthorization =
  | { kind: "deny" }
  | {
      kind: "actor";
      actorlessGrants?: readonly ActorlessServiceGrant[];
    };

/** Declarative authorization policy enforced by the router. */
export type RouteAuthorization =
  | { kind: "none" }
  | { kind: "authenticated" }
  | { kind: "active-self" }
  | { kind: "active-global"; service: ServiceAuthorization }
  | {
      kind: "active-user";
      allOf: readonly RouteAuthorizationRequirement[];
      service: ServiceAuthorization;
    }
  | {
      kind: "service";
      services: readonly BotServiceName[];
      actor: "required" | "optional";
    };

/**
 * Skips router-level permission checks after route authentication.
 *
 * The route may still require a service signature, a session-bound sandbox token, or credentials
 * verified by its handler. Only routes whose authentication policy is `public` are publicly
 * accessible.
 */
export const NO_AUTHORIZATION = { kind: "none" } as const satisfies RouteAuthorization;
/** Policy requiring any authenticated principal. */
export const AUTHENTICATED_USER = {
  kind: "authenticated",
} as const satisfies RouteAuthorization;
/** Policy requiring an active user to access their own account resource. */
export const ACTIVE_SELF = { kind: "active-self" } as const satisfies RouteAuthorization;

/** Build a global permission requirement for composition with other requirements. */
export function permissionRequirement(permission: PermissionId): RouteAuthorizationRequirement {
  return { kind: "permission", permission };
}

/** Require an active user with a global permission, optionally allowing service actors. */
export function requirePermission(
  permission: PermissionId,
  options?: { service?: "actor" | "deny"; actorlessGrants?: readonly ActorlessServiceGrant[] }
): RouteAuthorization {
  return {
    kind: "active-user",
    allOf: [permissionRequirement(permission)],
    service:
      options?.service === "deny"
        ? { kind: "deny" }
        : { kind: "actor", actorlessGrants: options?.actorlessGrants },
  };
}

/** Require an active user with at least one permission under a scoped stem. */
export function requireScopedPermission(
  stem: ScopedPermissionStem,
  options?: { service?: "actor" }
): RouteAuthorization {
  return {
    kind: "active-user",
    allOf: [{ kind: "scoped-permission", stem }],
    service: options?.service === "actor" ? { kind: "actor" } : { kind: "deny" },
  };
}

/** Require admission to manage or trigger the automation identified by a path parameter. */
export function requireAutomation(
  operation: "manage" | "trigger",
  automationIdParam = "id"
): RouteAuthorization {
  return {
    kind: "active-user",
    allOf: [{ kind: "automation", operation, automationIdParam }],
    service: { kind: "deny" },
  };
}

/** Require an active user to satisfy every supplied authorization requirement. */
export function requireAll(...allOf: readonly RouteAuthorizationRequirement[]): RouteAuthorization {
  return { kind: "active-user", allOf, service: { kind: "actor" } };
}

/** Require any active user, with optional actorless service grants. */
export function activeGlobal(options?: {
  actorlessGrants?: readonly ActorlessServiceGrant[];
}): RouteAuthorization {
  return {
    kind: "active-global",
    service: { kind: "actor", actorlessGrants: options?.actorlessGrants },
  };
}

/** Restrict a route to one trusted service, with optional actor identity. */
export function serviceAuthorized(
  service: BotServiceName,
  actor: "required" | "optional" = "optional"
): RouteAuthorization {
  return { kind: "service", services: [service], actor };
}

type UserPrincipal = Extract<Principal, { kind: "user" }>;
type SandboxPrincipal = Extract<Principal, { kind: "sandbox" }>;
type ServicePrincipal = Extract<Principal, { kind: "service" }>;
type WebServicePrincipal = Omit<ServicePrincipal, "service"> & { service: "web" };
type UserOrServicePrincipal = Exclude<Principal, SandboxPrincipal>;

type SandboxSessionBinding = {
  getSessionId(match: RegExpMatchArray): string | null;
};

export type RouteAuthentication =
  | { kind: "public" }
  | { kind: "handler-authenticated" }
  | { kind: "web-service" }
  | { kind: "service" }
  | { kind: "user" }
  | { kind: "user-or-service" }
  | ({ kind: "sandbox" } & SandboxSessionBinding)
  | ({ kind: "user-or-service-with-sandbox-fallback" } & SandboxSessionBinding);

export type RouteContext<Authentication extends RouteAuthentication> = RequestContext & {
  principal: Authentication extends { kind: "user" }
    ? UserPrincipal
    : Authentication extends { kind: "sandbox" }
      ? SandboxPrincipal
      : Authentication extends { kind: "web-service" }
        ? WebServicePrincipal
        : Authentication extends { kind: "service" }
          ? ServicePrincipal
          : Authentication extends { kind: "user-or-service" }
            ? UserOrServicePrincipal
            : Authentication extends { kind: "user-or-service-with-sandbox-fallback" }
              ? Principal
              : Principal | undefined;
};

export type UserRouteContext = RouteContext<{ kind: "user" }>;
export type SandboxRouteContext = RouteContext<{ kind: "sandbox" } & SandboxSessionBinding>;

export interface RoutePolicy {
  authentication: RouteAuthentication;
  supportedScmProviders: "all" | readonly SourceControlProviderName[];
}

export interface Route extends RouteDefinition, RoutePolicy {}

const SESSION_ID_BINDING: SandboxSessionBinding = {
  getSessionId: (match) => match.groups?.id ?? null,
};

export const GITHUB_USER_OR_SERVICE_ROUTE = {
  authentication: { kind: "user-or-service" },
  supportedScmProviders: ["github"],
} as const satisfies RoutePolicy;

export const GITHUB_SERVICE_ROUTE = {
  authentication: { kind: "service" },
  supportedScmProviders: ["github"],
} as const satisfies RoutePolicy;

export const SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE = {
  authentication: { kind: "user-or-service" },
  supportedScmProviders: "all",
} as const satisfies RoutePolicy;

export const SCM_AGNOSTIC_HUMAN_USER_ROUTE = {
  authentication: { kind: "user" },
  supportedScmProviders: "all",
} as const satisfies RoutePolicy;

export const SCM_AGNOSTIC_WEB_SERVICE_ROUTE = {
  authentication: { kind: "web-service" },
  supportedScmProviders: "all",
} as const satisfies RoutePolicy;

export const SCM_AGNOSTIC_HANDLER_AUTHENTICATED_ROUTE = {
  authentication: { kind: "handler-authenticated" },
  supportedScmProviders: "all",
} as const satisfies RoutePolicy;

export const GITHUB_SANDBOX_FALLBACK_ROUTE = {
  authentication: { kind: "user-or-service-with-sandbox-fallback", ...SESSION_ID_BINDING },
  supportedScmProviders: ["github"],
} as const satisfies RoutePolicy;

export const SCM_AGNOSTIC_SANDBOX_FALLBACK_ROUTE = {
  authentication: { kind: "user-or-service-with-sandbox-fallback", ...SESSION_ID_BINDING },
  supportedScmProviders: "all",
} as const satisfies RoutePolicy;

export const SCM_CREDENTIALS_ROUTE = {
  authentication: { kind: "sandbox", ...SESSION_ID_BINDING },
  supportedScmProviders: ["github", "gitlab"],
} as const satisfies RoutePolicy;

export const SCM_AGNOSTIC_SANDBOX_ROUTE = {
  authentication: { kind: "sandbox", ...SESSION_ID_BINDING },
  supportedScmProviders: "all",
} as const satisfies RoutePolicy;

export function defineRoutes<const Policy extends RoutePolicy>(
  policy: Policy,
  routes: RouteDefinition<RouteContext<Policy["authentication"]>>[]
): Route[] {
  return routes.map((route) => defineRoute(policy, route));
}

export function defineRoute<const Policy extends RoutePolicy>(
  policy: Policy,
  route: RouteDefinition<RouteContext<Policy["authentication"]>>
): Route {
  const handler: Route["handler"] = (request, env, match, ctx) =>
    route.handler(request, env, match, ctx as RouteContext<Policy["authentication"]>);
  return { ...route, ...policy, handler };
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
  const encodedOwner = match.groups?.owner;
  const encodedName = match.groups?.name;
  if (!encodedOwner || !encodedName) {
    return error("Owner and name are required", 400);
  }
  const repository = decodeRepositoryPathSegments(encodedOwner, encodedName);
  if (!repository) {
    return error("Owner and name must be valid repository path segments", 400);
  }
  return { owner: repository.repoOwner, name: repository.repoName };
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
