/** Framework-neutral authentication and authorization for a matched route. */

import {
  SCOPED_PERMISSION_PAIRS,
  resolveScopedPermission,
  type PermissionId,
} from "@open-inspect/shared/rbac";
import { authenticate, isAuthError } from "../auth/authenticate";
import type { Principal } from "../auth/principal";
import type {
  AuthorizationDecisionRequirement,
  RouteAuthorizationDecision,
} from "../authorization/request-audit";
import { AuthorizationError, AuthorizationService } from "../authorization/service";
import { serviceAllowsPermission } from "../authorization/service-permissions";
import { AutomationStore } from "../db/automation-store";
import { UserStore } from "../db/user-store";
import type { RequestContext } from "../http/request-context";
import { error, json } from "../http/responses";
import { createLogger } from "../logger";
import type {
  ActorlessServiceGrant,
  RouteAdmissionPolicy,
  RouteAuthentication,
  RouteAuthorizationRequirement,
  RouteParams,
} from "../routes/shared";
import { SessionInternalPaths } from "../session/contracts";
import { createSessionRuntimeClient } from "../session/runtime-client";
import { resolveScmProviderFromEnv, SourceControlProviderError } from "../source-control";
import type { Env } from "../types";
import { logPrincipal } from "./request-lifecycle";

const logger = createLogger("router");

export type AllowedAuthorizationDecision = Extract<RouteAuthorizationDecision, { kind: "allowed" }>;
export type DeniedAuthorizationDecision = Extract<RouteAuthorizationDecision, { kind: "denied" }>;

export type RouteAdmissionResult =
  | { kind: "admitted"; handlerRequest: Request; decision: AllowedAuthorizationDecision }
  | {
      kind: "denied";
      response: Response;
      requestLog: "emit" | "skip";
      /** Present for authorization denials; absent for authentication and infrastructure failures. */
      decision?: DeniedAuthorizationDecision;
    };

/** A denial with optional audit evidence; infrastructure failures carry none. */
export interface AuthorizationFailure {
  response: Response;
  decision?: DeniedAuthorizationDecision;
  /** Deployment-capability refusals skip the general request log, as at the final gate. */
  requestLog?: "emit" | "skip";
}

interface AuthorizationEvidence {
  requirements: AuthorizationDecisionRequirement[];
  effectivePermissions: PermissionId[];
}

type RouteAuthorizationResult =
  | { kind: "allowed"; decision: AllowedAuthorizationDecision }
  | { kind: "denied"; response: Response; decision: DeniedAuthorizationDecision }
  | { kind: "error"; response: Response; requestLog?: "emit" | "skip" };

function denied(
  response: Response,
  options?: { requestLog?: "emit" | "skip"; decision?: DeniedAuthorizationDecision }
): RouteAdmissionResult {
  return {
    kind: "denied",
    response,
    requestLog: options?.requestLog ?? "emit",
    ...(options?.decision ? { decision: options.decision } : {}),
  };
}

function emptyEvidence(): AuthorizationEvidence {
  return { requirements: [], effectivePermissions: [] };
}

function authorizationDenial(
  response: Response,
  evidence: AuthorizationEvidence,
  failedRequirement: AuthorizationDecisionRequirement,
  reasonCode: string,
  reason: string,
  failedPermission?: PermissionId
): AuthorizationFailure {
  return {
    response,
    decision: {
      kind: "denied",
      ...evidence,
      requirements: [...evidence.requirements, failedRequirement],
      reasonCode,
      reason,
      ...(failedPermission ? { failedPermission } : {}),
    },
  };
}

function authorizationUnavailable(): AuthorizationFailure {
  return {
    response: json({ error: "Authorization unavailable", code: "authorization_unavailable" }, 503),
  };
}

function resultForFailure(
  failure: AuthorizationFailure
): Exclude<RouteAuthorizationResult, { kind: "allowed" }> {
  return failure.decision
    ? { kind: "denied", response: failure.response, decision: failure.decision }
    : { kind: "error", response: failure.response, requestLog: failure.requestLog };
}

function enforceImplementedScmProvider(
  policy: RouteAdmissionPolicy,
  path: string,
  env: Env,
  ctx: RequestContext
): Response | null {
  try {
    const provider = resolveScmProviderFromEnv(env.SCM_PROVIDER);
    if (
      policy.supportedScmProviders !== "all" &&
      !policy.supportedScmProviders.includes(provider)
    ) {
      logger.warn("SCM provider not implemented", {
        event: "scm.provider_not_implemented",
        scm_provider: provider,
        http_path: path,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return error(`SCM provider '${provider}' is not implemented in this deployment.`, 501);
    }

    return null;
  } catch (errorValue) {
    const errorMessage =
      errorValue instanceof SourceControlProviderError
        ? errorValue.message
        : "Invalid SCM provider configuration";

    logger.error("Invalid SCM provider configuration", {
      event: "scm.provider_invalid",
      error: errorValue instanceof Error ? errorValue : String(errorValue),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return error(errorMessage, 500);
  }
}

async function verifySandboxAuth(
  request: Request,
  env: Env,
  sessionId: string,
  ctx: RequestContext
): Promise<Response | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return error("Unauthorized: Missing sandbox token", 401);
  }

  const token = authHeader.slice(7);
  const verifyResponse = await createSessionRuntimeClient(env, ctx).fetch(
    sessionId,
    SessionInternalPaths.verifySandboxToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }
  );

  if (!verifyResponse.ok) {
    const clientIP = request.headers.get("CF-Connecting-IP") || "unknown";
    logger.warn("Auth failed: sandbox", {
      event: "auth.sandbox_failed",
      http_path: new URL(request.url).pathname,
      client_ip: clientIP,
      session_id: sessionId,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Unauthorized: Invalid sandbox token", 401);
  }

  ctx.principal = { kind: "sandbox", sessionId };
  return null;
}

async function verifySandboxAuthSafely(
  request: Request,
  env: Env,
  sessionId: string,
  ctx: RequestContext
): Promise<Response | null> {
  try {
    return await verifySandboxAuth(request, env, sessionId, ctx);
  } catch (cause) {
    logger.error("Sandbox authentication unavailable", {
      event: "auth.sandbox_unavailable",
      session_id: sessionId,
      error: cause instanceof Error ? cause : String(cause),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Sandbox authentication unavailable", 503);
  }
}

/** Reject verified principals whose kind the route's authentication policy excludes. */
export function enforceRoutePrincipal(
  authentication: RouteAuthentication,
  principal: Principal,
  evidence: AuthorizationEvidence = emptyEvidence()
): AuthorizationFailure | null {
  if (
    authentication.kind === "web-service" &&
    (principal.kind !== "service" || principal.service !== "web")
  ) {
    return { response: error("Unauthorized", 401) };
  }
  if (authentication.kind === "user" && principal.kind !== "user") {
    return authorizationDenial(
      error("Human user authentication required", 403),
      evidence,
      { kind: "principal-type" },
      "principal_type_required",
      "Human user authentication required"
    );
  }
  if (authentication.kind === "service" && principal.kind !== "service") {
    return authorizationDenial(
      error("Service authentication required", 403),
      evidence,
      { kind: "principal-type" },
      "principal_type_required",
      "Service authentication required"
    );
  }
  return null;
}

/**
 * Load the canonical subject's effective authorization. Service actors reach
 * this step already finalized, so the subject is the admitted canonical user.
 */
/** Authorization kinds whose admission loads the canonical subject's role. */
function loadsCanonicalSubject(policy: RouteAdmissionPolicy): boolean {
  return (
    policy.authorization.kind === "active-user" ||
    policy.authorization.kind === "active-self" ||
    policy.authorization.kind === "active-global"
  );
}

async function enforceActiveUser(
  policy: RouteAdmissionPolicy,
  ctx: RequestContext,
  evidence: AuthorizationEvidence
): Promise<AuthorizationFailure | null> {
  if (!loadsCanonicalSubject(policy)) return null;
  if (
    ctx.principal?.kind === "service" &&
    ctx.principal.actor &&
    !ctx.principal.actor.canonicalUserId
  ) {
    // finalizeServiceActor runs for the same policy kinds; an unfinalized
    // actor here means enrollment was skipped, so never authorize it.
    return authorizationUnavailable();
  }
  const userId =
    ctx.principal?.kind === "user"
      ? ctx.principal.userId
      : ctx.principal?.kind === "service"
        ? ctx.principal.actor?.canonicalUserId
        : null;
  if (!userId) return null;
  const requirement = { kind: "active-user" } as const;
  try {
    const authorization = await new AuthorizationService(ctx.db).getEffectiveAuthorization(userId);
    ctx.authorization = authorization;
    if (authorization.suspendedAt !== null) {
      return authorizationDenial(
        json({ error: "Forbidden", code: "active_user_required" }, 403),
        evidence,
        requirement,
        "active_user_required",
        "Forbidden"
      );
    }
    evidence.requirements.push(requirement);
    return null;
  } catch (cause) {
    if (cause instanceof AuthorizationError) {
      return authorizationDenial(
        json({ error: "Forbidden", code: cause.code }, cause.status),
        evidence,
        requirement,
        cause.code,
        "Forbidden",
        cause.permission
      );
    }
    return authorizationUnavailable();
  }
}

/**
 * Reject declarative permission requirements outside the service's static
 * ceiling before the actor is enrolled, so a denied bot leaves no user,
 * identity, or assignment behind.
 */
function enforceStaticServicePermissionCeiling(
  policy: RouteAdmissionPolicy,
  ctx: RequestContext,
  evidence: AuthorizationEvidence
): AuthorizationFailure | null {
  const principal = ctx.principal;
  if (principal?.kind !== "service" || !principal.actor) return null;
  if (policy.authorization.kind !== "active-user") return null;

  for (const requirement of policy.authorization.allOf) {
    const permission =
      requirement.kind === "permission"
        ? requirement.permission
        : requirement.kind === "scoped-permission"
          ? SCOPED_PERMISSION_PAIRS[requirement.stem].own
          : null;
    if (permission && !serviceAllowsPermission(principal.service, permission)) {
      return authorizationDenial(
        json({ error: "Forbidden", code: "service_capability_required" }, 403),
        evidence,
        requirement,
        "service_capability_required",
        "Forbidden",
        permission
      );
    }
  }
  return null;
}

/**
 * Resolve the verified service actor to its canonical user exactly once,
 * before any RBAC lookup, so the subject authorized is the subject attributed.
 */
async function finalizeServiceActor(
  policy: RouteAdmissionPolicy,
  request: Request,
  pathname: string,
  env: Env,
  ctx: RequestContext
): Promise<AuthorizationFailure | null> {
  if (!loadsCanonicalSubject(policy)) return null;
  const principal = ctx.principal;
  if (principal?.kind !== "service" || !principal.actor || principal.actor.canonicalUserId) {
    return null;
  }

  // Deployment capability does not depend on the caller: a request this
  // deployment cannot serve must not enroll a user, identity, or assignment.
  const providerCheck = enforceImplementedScmProvider(policy, pathname, env, ctx);
  if (providerCheck) return { response: providerCheck, requestLog: "skip" };

  try {
    const prepared = policy.serviceActorClaims
      ? await policy.serviceActorClaims(request.clone(), ctx)
      : null;
    // The route refused this body: answer with its response and write nothing.
    if (prepared?.kind === "rejected") return { response: prepared.response };
    const claims = prepared?.claims;
    const actor = principal.actor;
    const user = await new UserStore(ctx.db).resolveOrCreateUser({
      provider: actor.provider,
      providerUserId: actor.providerUserId,
      displayName: claims?.displayName,
      providerEmail:
        actor.provider === "slack" || actor.provider === "linear" ? claims?.email : undefined,
      avatarUrl: claims?.avatarUrl,
    });
    ctx.principal = {
      ...principal,
      actor: { ...actor, canonicalUserId: user.id },
    };
    return null;
  } catch (cause) {
    logger.error("Failed to finalize verified service actor", {
      event: "auth.service_actor_resolution_failed",
      error: cause instanceof Error ? cause : String(cause),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return authorizationUnavailable();
  }
}

function authorizationUserId(ctx: RequestContext): string | null {
  if (ctx.principal?.kind === "user") return ctx.principal.userId;
  if (ctx.principal?.kind === "service") {
    return ctx.principal.actor?.canonicalUserId ?? ctx.authorization?.userId ?? null;
  }
  return null;
}

function actorlessGrantMatches(
  grant: ActorlessServiceGrant,
  service: string,
  params: RouteParams
): boolean {
  if (grant.service !== service) return false;
  return Object.entries(grant.pathParams ?? {}).every(
    ([name, expected]) => params[name] === expected
  );
}

function enforceServiceRouteAuthorization(
  policy: RouteAdmissionPolicy,
  params: RouteParams,
  ctx: RequestContext,
  evidence: AuthorizationEvidence
): AuthorizationFailure | null {
  const principal = ctx.principal;
  const authorization = policy.authorization;
  const requirement = { kind: "service-capability" } as const;
  const serviceCapabilityRequired = (): AuthorizationFailure =>
    authorizationDenial(
      json({ error: "Forbidden", code: "service_capability_required" }, 403),
      evidence,
      requirement,
      "service_capability_required",
      "Forbidden"
    );
  const serviceActorRequired = (): AuthorizationFailure =>
    authorizationDenial(
      json({ error: "Forbidden", code: "service_actor_required" }, 403),
      evidence,
      requirement,
      "service_actor_required",
      "Forbidden"
    );

  if (authorization.kind === "service") {
    if (principal?.kind !== "service") return serviceCapabilityRequired();
    if (!authorization.services.some((service) => service === principal.service)) {
      return serviceCapabilityRequired();
    }
    if (authorization.actor === "required" && !principal.actor) {
      return serviceActorRequired();
    }
    evidence.requirements.push(requirement);
    return null;
  }
  if (principal?.kind !== "service") return null;
  if (policy.authentication.kind === "web-service" && principal.service === "web") return null;
  if (
    (authorization.kind !== "active-user" && authorization.kind !== "active-global") ||
    authorization.service.kind === "deny"
  ) {
    return serviceCapabilityRequired();
  }
  if (principal.actor) {
    evidence.requirements.push(requirement);
    return null;
  }
  const granted = authorization.service.actorlessGrants?.some((grant) =>
    actorlessGrantMatches(grant, principal.service, params)
  );
  if (granted) {
    evidence.requirements.push({ kind: "actorless-service-grant", service: principal.service });
    return null;
  }
  return serviceActorRequired();
}

async function enforcePermissionRequirement(
  requirement: Extract<RouteAuthorizationRequirement, { kind: "permission" }>,
  ctx: RequestContext,
  evidence: AuthorizationEvidence
): Promise<AuthorizationFailure | null> {
  if (
    ctx.principal?.kind === "service" &&
    !serviceAllowsPermission(ctx.principal.service, requirement.permission)
  ) {
    return authorizationDenial(
      json({ error: "Forbidden", code: "service_capability_required" }, 403),
      evidence,
      requirement,
      "service_capability_required",
      "Forbidden",
      requirement.permission
    );
  }
  const userId = authorizationUserId(ctx);
  if (!userId) {
    evidence.requirements.push(requirement);
    return null;
  }
  if (ctx.authorization?.permissions.includes(requirement.permission)) {
    evidence.requirements.push(requirement);
    evidence.effectivePermissions.push(requirement.permission);
    return null;
  }
  return authorizationDenial(
    json(
      { error: "Forbidden", code: "permission_required", permission: requirement.permission },
      403
    ),
    evidence,
    requirement,
    "permission_required",
    "Forbidden",
    requirement.permission
  );
}

async function enforceScopedPermissionRequirement(
  requirement: Extract<RouteAuthorizationRequirement, { kind: "scoped-permission" }>,
  ctx: RequestContext,
  evidence: AuthorizationEvidence
): Promise<AuthorizationFailure | null> {
  const pair = SCOPED_PERMISSION_PAIRS[requirement.stem];
  if (
    ctx.principal?.kind === "service" &&
    !serviceAllowsPermission(ctx.principal.service, pair.own)
  ) {
    return authorizationDenial(
      json({ error: "Forbidden", code: "service_capability_required" }, 403),
      evidence,
      requirement,
      "service_capability_required",
      "Forbidden",
      pair.own
    );
  }
  const userId = authorizationUserId(ctx);
  if (!userId) {
    evidence.requirements.push(requirement);
    return null;
  }
  const scope = ctx.authorization
    ? resolveScopedPermission(requirement.stem, ctx.authorization.permissions)
    : null;
  if (scope) {
    evidence.requirements.push(requirement);
    evidence.effectivePermissions.push(pair[scope]);
    return null;
  }
  return authorizationDenial(
    json({ error: "Forbidden", code: "permission_required", permission: pair.own }, 403),
    evidence,
    requirement,
    "permission_required",
    "Forbidden",
    pair.own
  );
}

async function enforceAutomationRequirement(
  requirement: Extract<RouteAuthorizationRequirement, { kind: "automation" }>,
  params: RouteParams,
  ctx: RequestContext,
  evidence: AuthorizationEvidence
): Promise<AuthorizationFailure | null> {
  if (ctx.principal?.kind !== "user") {
    // Ownership is defined for canonical human users only. Service policy
    // normally rejects bots earlier; this keeps a future `requireAll`
    // composition from skipping the ownership check.
    return authorizationDenial(
      json({ error: "Forbidden", code: "service_capability_required" }, 403),
      evidence,
      requirement,
      "service_capability_required",
      "Forbidden"
    );
  }
  const automationId = params[requirement.automationIdParam];
  if (!automationId) return { response: json({ error: "Invalid automation route" }, 400) };

  try {
    const authorization = ctx.authorization;
    if (!authorization) throw new Error("Missing request authorization");
    const store = new AutomationStore(ctx.db);
    const storedAutomation = await store.getById(automationId);
    if (!storedAutomation) return { response: error("Automation not found", 404) };
    const automation = await store.resolveCanonicalOwner(storedAutomation);

    const permissionStem = `automations.${requirement.operation}` as const;
    const pair = SCOPED_PERMISSION_PAIRS[permissionStem];
    const isOwner = automation.user_id === ctx.principal.userId;
    const scope = resolveScopedPermission(permissionStem, authorization.permissions);
    if (!scope || (scope === "own" && !isOwner)) {
      return authorizationDenial(
        json({ error: "Forbidden", code: "permission_required", permission: pair.own }, 403),
        evidence,
        requirement,
        "permission_required",
        "Forbidden",
        pair.own
      );
    }

    evidence.requirements.push(requirement);
    evidence.effectivePermissions.push(pair[scope]);
    ctx.automationAdmission = { automation };
    return null;
  } catch {
    return authorizationUnavailable();
  }
}

function allowed(
  policy: RouteAdmissionPolicy,
  admission: AllowedAuthorizationDecision["admission"],
  evidence: AuthorizationEvidence
): RouteAuthorizationResult {
  return {
    kind: "allowed",
    decision: {
      kind: "allowed",
      admission,
      auditAllowed: policy.authorization.auditAllowed,
      ...evidence,
    },
  };
}

/**
 * Ordered trust transition for an authenticated request: principal kind,
 * sandbox capability, service capability and ceiling, actor finalization,
 * active canonical subject, then route permission and resource requirements.
 */
async function enforceRouteAuthorization(
  policy: RouteAdmissionPolicy,
  params: RouteParams,
  request: Request,
  pathname: string,
  env: Env,
  ctx: RequestContext
): Promise<RouteAuthorizationResult> {
  const evidence = emptyEvidence();
  const principal = ctx.principal;
  if (!principal) {
    // Only a route that declares no authorization may run without a subject.
    if (policy.authorization.kind !== "none") {
      return { kind: "error", response: error("Unauthorized", 401) };
    }
    return allowed(policy, "user", evidence);
  }

  const principalFailure = enforceRoutePrincipal(policy.authentication, principal, evidence);
  if (principalFailure) return resultForFailure(principalFailure);

  if (
    principal.kind === "sandbox" &&
    policy.authentication.kind === "user-or-service-with-sandbox-fallback"
  ) {
    evidence.requirements.push({ kind: "sandbox-admission", sessionId: principal.sessionId });
    return allowed(policy, "sandbox", evidence);
  }

  const serviceFailure = enforceServiceRouteAuthorization(policy, params, ctx, evidence);
  if (serviceFailure) return resultForFailure(serviceFailure);

  const ceilingFailure = enforceStaticServicePermissionCeiling(policy, ctx, evidence);
  if (ceilingFailure) return resultForFailure(ceilingFailure);

  const actorFailure = await finalizeServiceActor(policy, request, pathname, env, ctx);
  if (actorFailure) return resultForFailure(actorFailure);

  const activeUserFailure = await enforceActiveUser(policy, ctx, evidence);
  if (activeUserFailure) return resultForFailure(activeUserFailure);

  if (policy.authorization.kind === "active-user") {
    for (const requirement of policy.authorization.allOf) {
      let failure: AuthorizationFailure | null;
      switch (requirement.kind) {
        case "permission":
          failure = await enforcePermissionRequirement(requirement, ctx, evidence);
          break;
        case "scoped-permission":
          failure = await enforceScopedPermissionRequirement(requirement, ctx, evidence);
          break;
        case "automation":
          failure = await enforceAutomationRequirement(requirement, params, ctx, evidence);
          break;
      }
      if (failure) return resultForFailure(failure);
    }
  }

  const admission =
    principal.kind === "service" ? "service" : principal.kind === "sandbox" ? "sandbox" : "user";
  return allowed(policy, admission, evidence);
}

export async function admitRoute(input: {
  request: Request;
  env: Env;
  policy: RouteAdmissionPolicy;
  params: RouteParams;
  pathname: string;
  ctx: RequestContext;
}): Promise<RouteAdmissionResult> {
  const { env, params, pathname, policy, ctx } = input;
  let handlerRequest = input.request;
  const authentication = policy.authentication;

  if (authentication.kind !== "public" && authentication.kind !== "handler-authenticated") {
    let authError: Response | null;
    const sandboxSessionId =
      authentication.kind === "sandbox" ||
      authentication.kind === "user-or-service-with-sandbox-fallback"
        ? authentication.getSessionId(params)
        : null;

    if (authentication.kind === "sandbox") {
      authError = sandboxSessionId
        ? await verifySandboxAuthSafely(handlerRequest, env, sandboxSessionId, ctx)
        : error("Unauthorized: Invalid session path", 401);
    } else {
      const authResult = await authenticate(handlerRequest, env, ctx, {
        webService:
          authentication.kind === "web-service" || authentication.kind === "service"
            ? "service"
            : "user",
      });

      if (isAuthError(authResult)) {
        // A service-credential attempt is terminal; only a request with no
        // recognized credential may still be a sandbox-token call on a
        // sandbox-accepting route.
        authError = error(authResult.reason, authResult.status);
        if (
          authResult.failedScheme === "none" &&
          authentication.kind === "user-or-service-with-sandbox-fallback" &&
          sandboxSessionId
        ) {
          authError = await verifySandboxAuthSafely(handlerRequest, env, sandboxSessionId, ctx);
        }
      } else {
        authError = null;
        ctx.principal = authResult.principal;
        ctx.authentication = authResult.authentication;
        handlerRequest = authResult.request;
      }
    }

    if (authError) {
      if (ctx.principal) {
        logPrincipal(ctx.principal, ctx, pathname);
      }
      return denied(authError, { requestLog: ctx.principal ? "emit" : "skip" });
    }

    if (ctx.principal) {
      logPrincipal(ctx.principal, ctx, pathname);
    }
  }

  const authorization = await enforceRouteAuthorization(
    policy,
    params,
    handlerRequest,
    pathname,
    env,
    ctx
  );
  if (authorization.kind === "denied") {
    return denied(authorization.response, { decision: authorization.decision });
  }
  if (authorization.kind === "error") {
    return denied(authorization.response, { requestLog: authorization.requestLog });
  }

  const providerCheck = enforceImplementedScmProvider(policy, pathname, env, ctx);
  if (providerCheck) {
    return denied(providerCheck, { requestLog: "skip" });
  }

  return { kind: "admitted", handlerRequest, decision: authorization.decision };
}
