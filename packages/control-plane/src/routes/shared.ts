/**
 * Shared route primitives used by all route modules.
 */

import type { Principal } from "../auth/principal";
import type { RequestContext } from "../http/request-context";
import { HttpError } from "../http/responses";
import type { Env } from "../types";
import type { Logger } from "../logger";
import type { PermissionId, ScopedPermissionStem } from "@open-inspect/shared/rbac";
import type { ServiceName } from "@open-inspect/shared/service-auth";
import {
  createSourceControlProviderFromEnv,
  SourceControlProviderError,
  type SourceControlProvider,
  type RepositoryAccessResult,
  type SourceControlProviderName,
} from "../source-control";

export type { AutomationRouteAdmission, RequestContext } from "../http/request-context";
export { error, HttpError, json } from "../http/responses";

/** Profile data a route can extract from an already verified service request. */
export interface ServiceActorProfileClaims {
  displayName?: string;
  email?: string;
  avatarUrl?: string;
}

/**
 * Outcome of preparing a route's actor claims before identity is finalized.
 * A rejected body ends admission with the route's own response, so no user,
 * identity, or assignment is written for a request the handler would refuse.
 */
export type ServiceActorClaimsResult =
  | { kind: "claims"; claims: ServiceActorProfileClaims }
  | { kind: "rejected"; response: Response };

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
const DEFAULT_AUDIT_ALLOWED = false;

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
  | { kind: "none"; auditAllowed: false }
  | { kind: "authenticated"; auditAllowed: false }
  | { kind: "active-self"; auditAllowed: boolean }
  | { kind: "active-global"; service: ServiceAuthorization; auditAllowed: boolean }
  | {
      kind: "active-user";
      allOf: readonly RouteAuthorizationRequirement[];
      service: ServiceAuthorization;
      auditAllowed: boolean;
    }
  | {
      kind: "service";
      services: readonly BotServiceName[];
      actor: "required" | "optional";
      auditAllowed: true;
    };

/**
 * Skips router-level permission checks after route authentication.
 *
 * The route may still require a service signature, a session-bound sandbox token, or credentials
 * verified by its handler. Only routes whose authentication policy is `public` are publicly
 * accessible.
 */
export const NO_AUTHORIZATION = {
  kind: "none",
  auditAllowed: DEFAULT_AUDIT_ALLOWED,
} as const satisfies RouteAuthorization;
/** Policy requiring any authenticated principal. */
export const AUTHENTICATED_USER = {
  kind: "authenticated",
  auditAllowed: DEFAULT_AUDIT_ALLOWED,
} as const satisfies RouteAuthorization;
/** Policy requiring an active user to access their own account resource. */
export function activeSelf(options?: { auditAllowed?: boolean }): RouteAuthorization {
  return {
    kind: "active-self",
    auditAllowed: options?.auditAllowed ?? DEFAULT_AUDIT_ALLOWED,
  };
}
export const ACTIVE_SELF = activeSelf();

const AUDITED_ALLOWED_PERMISSIONS = new Set<PermissionId>([
  "automations.create",
  "automations.manage.any",
  "automations.manage.own",
  "automations.trigger.any",
  "automations.trigger.own",
  "commit_signing.manage",
  "environments.images.manage",
  "environments.manage",
  "environments.secrets.manage",
  "environments.settings.manage",
  "global_secrets.manage",
  "integrations.manage",
  "mcp_servers.manage",
  "models.preferences.manage",
  "provider_accounts.manage",
  "repositories.images.manage",
  "repositories.secrets.manage",
  "repositories.settings.manage",
  "scm_settings.manage",
  "sessions.collaborate",
  "sessions.create",
  "sessions.delete",
  "sessions.lifecycle",
  "sessions.sandbox_access",
  "skill_profiles.manage_own",
  "skills.manage",
  "workspace.members.manage",
  "workspace.transfer_ownership",
]);

function auditsAllowedRequirement(requirement: RouteAuthorizationRequirement): boolean {
  if (requirement.kind === "permission") {
    return AUDITED_ALLOWED_PERMISSIONS.has(requirement.permission);
  }
  return true;
}

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
    auditAllowed: AUDITED_ALLOWED_PERMISSIONS.has(permission),
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
    auditAllowed: true,
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
    auditAllowed: true,
  };
}

/** Require an active user to satisfy every supplied authorization requirement. */
export function requireAll(...allOf: readonly RouteAuthorizationRequirement[]): RouteAuthorization {
  return {
    kind: "active-user",
    allOf,
    service: { kind: "actor" },
    auditAllowed: allOf.some(auditsAllowedRequirement),
  };
}

/** Require any active user, with optional actorless service grants. */
export function activeGlobal(options?: {
  actorlessGrants?: readonly ActorlessServiceGrant[];
  auditAllowed?: boolean;
}): RouteAuthorization {
  return {
    kind: "active-global",
    service: { kind: "actor", actorlessGrants: options?.actorlessGrants },
    auditAllowed: options?.auditAllowed ?? DEFAULT_AUDIT_ALLOWED,
  };
}

/** Restrict a route to one trusted service, with optional actor identity. */
export function serviceAuthorized(
  service: BotServiceName,
  actor: "required" | "optional" = "optional"
): RouteAuthorization {
  return { kind: "service", services: [service], actor, auditAllowed: true };
}

type UserPrincipal = Extract<Principal, { kind: "user" }>;
type SandboxPrincipal = Extract<Principal, { kind: "sandbox" }>;
type ServicePrincipal = Extract<Principal, { kind: "service" }>;
type WebServicePrincipal = Omit<ServicePrincipal, "service"> & { service: "web" };
type UserOrServicePrincipal = Exclude<Principal, SandboxPrincipal>;

/** Raw path parameters of the selected route, keyed by parameter name. */
export type RouteParams = Readonly<Record<string, string>>;

type SandboxSessionBinding = {
  getSessionId(params: RouteParams): string | null;
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

/** Framework-neutral policy consumed by request admission. */
export interface RouteAdmissionPolicy extends RoutePolicy {
  /** Authorization policy enforced before the handler runs. */
  authorization: RouteAuthorization;
  /**
   * Extract profile claims asserted by the trusted service that owns this
   * route. Authentication has already verified the exact request body before
   * this hook runs. Invalid route input returns the route's own rejection so
   * admission stops before any identity is written.
   */
  serviceActorClaims?: (request: Request, ctx: RequestContext) => Promise<ServiceActorClaimsResult>;
}

const SESSION_ID_BINDING: SandboxSessionBinding = {
  getSessionId: (params) => params.id ?? null,
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
