/** Framework-neutral authentication and authorization for a matched route. */

import { authenticate, isAuthError } from "../auth/authenticate";
import { canonicalUserIdOf, SERVICE_PROFILES, type Principal } from "../auth/principal";
import { PersonalAccessTokenStore } from "../db/personal-access-tokens";
import { restrictAuthorizationToGrant } from "../authorization/personal-access-token-policy";
import {
  evaluateOwnedResourceAdmission,
  ownedResourceAdmissionResponse,
} from "../authorization/owned-resource-admission";
import type { RouteAuthorizationDecision } from "../authorization/request-audit";
import { AuthorizationError, AuthorizationService } from "../authorization/service";
import { serviceAllowsPermission } from "../authorization/service-permissions";
import { parseChannelScope } from "../authorization/channel-scope";
import { evaluateSessionAdmission } from "../authorization/session-admission";
import { legacyPermissionForAction } from "../authorization/teams-enforcement";
import { TeamChannelBindingStore } from "../db/team-channel-bindings";
import { SessionIndexStore } from "../db/session-index";
import type { RequestContext } from "../http/request-context";
import { error, json } from "../http/responses";
import { createLogger } from "../logger";
import type {
  ActorlessServiceGrant,
  RouteAdmissionPolicy,
  RouteAuthorization,
  RouteAuthorizationRequirement,
  RouteParams,
} from "../routes/shared";
import type { Env } from "../types";
import { logPrincipal } from "./request-lifecycle";
import { verifySandboxAuthSafely } from "./sandbox-authentication";
import { enforceImplementedScmProvider } from "./scm-provider-support";
import { finalizeServiceActor } from "./service-actor-finalization";
import { enforceTeamRequirement } from "./team-admission";
import {
  authorizationDenial,
  authorizationUnavailable,
  type AuthorizationEvidence,
  type AuthorizationFailure,
} from "./authorization-evidence";

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

function resultForFailure(
  failure: AuthorizationFailure
): Exclude<RouteAuthorizationResult, { kind: "allowed" }> {
  return failure.decision
    ? { kind: "denied", response: failure.response, decision: failure.decision }
    : { kind: "error", response: failure.response, requestLog: failure.requestLog };
}

/**
 * Reject verified principals whose kind the route's policy excludes. A personal access token is
 * admitted only where the route declares it, whatever else the route accepts.
 */
export function enforceRoutePrincipal(
  policy: Pick<RouteAdmissionPolicy, "authentication" | "personalAccessTokens">,
  principal: Principal,
  evidence: AuthorizationEvidence = emptyEvidence()
): AuthorizationFailure | null {
  const authentication = policy.authentication;
  if (principal.kind === "personal-access-token") {
    if (policy.personalAccessTokens === "accept") return null;
    return authorizationDenial(
      json(
        {
          error: "This route does not accept personal access tokens",
          code: "personal_access_token_not_accepted",
        },
        403
      ),
      evidence,
      { kind: "principal-type" },
      "personal_access_token_not_accepted",
      "This route does not accept personal access tokens"
    );
  }
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

/** Authorization kinds whose admission loads the canonical subject's role. */
function loadsCanonicalSubject(policy: RouteAdmissionPolicy): boolean {
  return (
    policy.authorization.kind === "active-user" ||
    policy.authorization.kind === "active-self" ||
    policy.authorization.kind === "active-global"
  );
}

/**
 * Load the canonical subject's effective authorization. Service actors reach
 * this step already finalized, so the subject is the admitted canonical user.
 */
async function enforceActiveUser(
  ctx: RequestContext,
  evidence: AuthorizationEvidence
): Promise<AuthorizationFailure | null> {
  if (
    ctx.principal?.kind === "service" &&
    ctx.principal.actor &&
    !ctx.principal.actor.canonicalUserId
  ) {
    // finalizeServiceActor runs for the same policy kinds; an unfinalized
    // actor here means enrollment was skipped, so never authorize it.
    return authorizationUnavailable();
  }
  const userId = canonicalUserIdOf(ctx.principal);
  if (!userId) return null;
  const requirement = { kind: "active-user" } as const;
  try {
    const authorization = await new AuthorizationService(ctx.db).getEffectiveAuthorization(userId);
    // A token acts as its owner within its grant. Narrowing here, where the subject's
    // authorization is loaded, is what every later permission check reads.
    ctx.authorization =
      ctx.principal?.kind === "personal-access-token"
        ? restrictAuthorizationToGrant(authorization, ctx.principal.grant)
        : authorization;
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
        : requirement.kind === "session"
          ? legacyPermissionForAction(requirement.action)
          : requirement.kind === "environment"
            ? (`environments.${requirement.need}` as const)
            : requirement.kind === "automation" && requirement.operation === "read"
              ? "automations.read"
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

async function enforceSlackWriteScope(
  params: RouteParams,
  request: Request,
  pathname: string,
  ctx: RequestContext,
  evidence: AuthorizationEvidence
): Promise<AuthorizationFailure | null> {
  if (
    ctx.principal?.kind !== "service" ||
    ctx.principal.service !== "slack-bot" ||
    request.method !== "POST" ||
    !/^\/sessions\/[^/]+\/(prompt|attachments)$/.test(pathname)
  ) {
    return null;
  }

  const refusal = { error: "Slack channel scope denied", code: "slack_channel_scope_denied" };
  const deny = (status: 400 | 403 | 404): AuthorizationFailure =>
    authorizationDenial(
      json(refusal, status),
      evidence,
      { kind: "session", sessionIdParam: "id", action: "collaborate" },
      refusal.code,
      refusal.error
    );
  const channels = new URL(request.url).searchParams.getAll("channel");
  const scope = channels.length === 1 ? parseChannelScope(channels[0]) : null;
  if (!scope || scope.provider !== "slack") return deny(400);

  try {
    const [binding, session] = await Promise.all([
      new TeamChannelBindingStore(ctx.db).get("slack", scope.externalId),
      new SessionIndexStore(ctx.db).get(params.id),
    ]);
    if (!session) return deny(404);
    if ((binding?.teamId ?? null) !== session.ownerTeamId) return deny(403);
    // Actor collaboration is authorized separately after this live channel check.
    return null;
  } catch (cause) {
    logger.error("Slack channel scope authorization unavailable", {
      event: "authorization.slack_channel_scope_unavailable",
      error: cause instanceof Error ? cause : String(cause),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return { response: json(refusal, 503) };
  }
}

function authorizationUserId(ctx: RequestContext): string | null {
  if (ctx.principal?.kind === "service") {
    return ctx.principal.actor?.canonicalUserId ?? ctx.authorization?.userId ?? null;
  }
  return canonicalUserIdOf(ctx.principal);
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

function routeOptsIn(authorization: RouteAuthorization, service: string): boolean {
  return (
    (authorization.kind === "active-user" || authorization.kind === "active-global") &&
    authorization.service.kind === "actor" &&
    (authorization.service.optInServices?.some((optIn) => optIn === service) ?? false)
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

  // Opt-in services reach only routes that name them. This runs before every
  // other branch, so a service-only route cannot admit one either.
  if (
    principal?.kind === "service" &&
    SERVICE_PROFILES[principal.service].routeAccess === "opt-in" &&
    !routeOptsIn(authorization, principal.service)
  ) {
    return serviceCapabilityRequired();
  }
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

async function enforceOwnedResourceRequirement(
  requirement: Extract<RouteAuthorizationRequirement, { kind: "automation" | "environment" }>,
  params: RouteParams,
  ctx: RequestContext,
  evidence: AuthorizationEvidence
): Promise<AuthorizationFailure | null> {
  try {
    const result = await evaluateOwnedResourceAdmission(requirement, params, ctx);
    // Denials keep the loaded environment too, so the audit attributes its owner team.
    if (result.kind !== "error" && "admission" in result && result.admission) {
      ctx.environmentAdmission = result.admission;
    }
    if (result.kind === "error") {
      return { response: ownedResourceAdmissionResponse(result) };
    }
    if (result.kind === "denied") {
      return authorizationDenial(
        ownedResourceAdmissionResponse(result),
        evidence,
        requirement,
        result.reasonCode,
        result.reason,
        result.failedPermission
      );
    }
    evidence.requirements.push(requirement);
    if (result.effectivePermission) evidence.effectivePermissions.push(result.effectivePermission);
    return null;
  } catch {
    return authorizationUnavailable();
  }
}

async function enforceSessionRequirement(
  requirement: Extract<RouteAuthorizationRequirement, { kind: "session" }>,
  params: RouteParams,
  request: Request,
  env: Env,
  ctx: RequestContext,
  evidence: AuthorizationEvidence
): Promise<AuthorizationFailure | null> {
  const sessionId = params[requirement.sessionIdParam];
  if (!sessionId) return { response: json({ error: "Invalid session route" }, 400) };
  try {
    if (ctx.principal?.kind === "service" && !ctx.principal.actor) {
      const query = new URL(request.url).searchParams;
      const channels = query.getAll("channel");
      const postRead = query.get("purpose") === "slack-post";
      if (postRead && (channels.length !== 1 || ctx.principal.service !== "slack-bot")) {
        return authorizationDenial(
          error("Session not found", 404),
          evidence,
          requirement,
          "session_not_visible",
          "Session not found"
        );
      }
      if (channels.length > 0) {
        const scope = channels.length === 1 ? parseChannelScope(channels[0]) : null;
        if (!scope || ctx.principal.service !== `${scope.provider}-bot`) {
          return authorizationDenial(
            error("Session not found", 404),
            evidence,
            requirement,
            "session_not_visible",
            "Session not found"
          );
        }
        ctx.serviceTeamId =
          (await new TeamChannelBindingStore(ctx.db).get(scope.provider, scope.externalId))
            ?.teamId ?? null;
        if (postRead) ctx.serviceReadPurpose = "slack-post";
      }
    }
    const result = await evaluateSessionAdmission(
      ctx,
      env,
      sessionId,
      requirement.action,
      requirement.sessionIdParam === "childId" ? "child" : "session",
      requirement.enforceAlways
    );
    if (result.kind === "not_found") {
      return authorizationDenial(
        error("Session not found", 404),
        evidence,
        requirement,
        "session_not_visible",
        "Session not found"
      );
    }
    if (result.kind === "action_denied") {
      return authorizationDenial(
        json(
          { error: "Forbidden", code: "session_action_denied", reason_code: result.reason },
          403
        ),
        evidence,
        requirement,
        result.reason,
        "Forbidden"
      );
    }
    if (result.legacyPermission) {
      const legacy = await enforcePermissionRequirement(
        { kind: "permission", permission: result.legacyPermission },
        ctx,
        evidence
      );
      if (legacy) return legacy;
    }
    evidence.requirements.push(requirement);
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
 * sandbox capability, service capability and ceiling, Slack write scope, actor finalization,
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

  const principalFailure = enforceRoutePrincipal(policy, principal, evidence);
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

  const scopeFailure = await enforceSlackWriteScope(params, request, pathname, ctx, evidence);
  if (scopeFailure) return resultForFailure(scopeFailure);

  if (loadsCanonicalSubject(policy)) {
    const actorFailure = await finalizeServiceActor(policy, request, pathname, env, ctx);
    if (actorFailure) return resultForFailure(actorFailure);

    const activeUserFailure = await enforceActiveUser(ctx, evidence);
    if (activeUserFailure) return resultForFailure(activeUserFailure);
  }

  if (policy.authorization.kind === "active-user") {
    for (const requirement of policy.authorization.allOf) {
      let failure: AuthorizationFailure | null;
      switch (requirement.kind) {
        case "permission":
          failure = await enforcePermissionRequirement(requirement, ctx, evidence);
          break;
        case "automation":
        case "environment":
          failure = await enforceOwnedResourceRequirement(requirement, params, ctx, evidence);
          break;
        case "team":
          failure = await enforceTeamRequirement(requirement, params, ctx, evidence);
          break;
        case "session":
          failure = await enforceSessionRequirement(
            requirement,
            params,
            request,
            env,
            ctx,
            evidence
          );
          break;
      }
      if (failure) return resultForFailure(failure);
    }
  }

  return allowed(policy, principal.kind, evidence);
}

/**
 * Record that a token was presented, off the request's critical path. Here rather than in
 * `authenticate()`, whose narrow port has no background tasks.
 */
function recordPersonalAccessTokenUse(ctx: RequestContext, tokenId: string): void {
  ctx.executionCtx.submit(
    () => new PersonalAccessTokenStore(ctx.db).touchLastUsed(tokenId, Date.now()),
    { name: "personal-access-token.touch-last-used", context: { token_id: tokenId } }
  );
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
        if (authResult.principal.kind === "personal-access-token") {
          recordPersonalAccessTokenUse(ctx, authResult.principal.tokenId);
        }
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
