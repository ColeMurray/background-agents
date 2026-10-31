/**
 * Resolving a verified service actor to its canonical user: enrolling an unknown actor under
 * workspace admission, and completing a known actor's profile from its route's claims.
 */

import {
  ACTOR_ADMISSION_DENIED_CODE,
  ACTOR_EMAIL_REQUIRED_CODE,
  type ActorProfileClaims,
} from "@open-inspect/shared/types/actors";
import { AdmissionDeniedError, admissionPolicyConfigFromEnv } from "../auth/user/admission-policy";
import { resolveEffectiveAdmissionPolicy } from "../auth/user/effective-admission-policy";
import { AdmissionPolicyStore } from "../db/admission-policy-store";
import { normalizeEmail } from "../db/email";
import { IdentityClaimStore } from "../db/identity-claim-store";
import { isEmailAttestingProvider, requiresEnrollmentEmail, UserStore } from "../db/user-store";
import type { RequestContext } from "../http/request-context";
import { json } from "../http/responses";
import { createLogger } from "../logger";
import type { RouteAdmissionPolicy, ServiceActorClaimsResult } from "../routes/shared";
import type { Env } from "../types";
import { authorizationUnavailable, type AuthorizationFailure } from "./authorization-evidence";
import { KnownActorProfileClaim, type KnownActor } from "./known-actor-profile";
import { enforceImplementedScmProvider } from "./scm-provider-support";

const logger = createLogger("router");

/**
 * Resolve the verified service actor to its canonical user exactly once,
 * before any RBAC lookup, so the subject authorized is the subject attributed.
 * An actor already known still has its route's profile claims applied, since
 * the request that enrolled it may have carried none. An unknown actor from a
 * provider that requires an enrollment email is refused without one.
 *
 * Admission calls this only for policies that load the canonical subject.
 */
export async function finalizeServiceActor(
  policy: RouteAdmissionPolicy,
  request: Request,
  pathname: string,
  env: Env,
  ctx: RequestContext
): Promise<AuthorizationFailure | null> {
  const principal = ctx.principal;
  if (principal?.kind !== "service" || !principal.actor) return null;
  if (principal.actor.canonicalUserId) {
    await completeKnownActorProfile(policy, request, ctx, {
      ...principal.actor,
      canonicalUserId: principal.actor.canonicalUserId,
    });
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
    const email = isEmailAttestingProvider(actor.provider) ? normalizeEmail(claims?.email) : null;
    if (requiresEnrollmentEmail(actor.provider) && email === null) {
      logger.warn("Refused to enroll a service actor without an attested email", {
        event: "auth.service_actor_email_required",
        provider: actor.provider,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return {
        response: json(
          { error: "Actor enrollment requires an attested email", code: ACTOR_EMAIL_REQUIRED_CODE },
          403
        ),
      };
    }
    // Resolve existing accounts first so linking preserves role and suspension;
    // the store checks admission immediately before creating a new user.
    const user = await new UserStore(ctx.db).resolveOrCreateUser(
      {
        provider: actor.provider,
        providerUserId: actor.providerUserId,
        displayName: claims?.displayName,
        providerEmail: email ?? undefined,
        avatarUrl: claims?.avatarUrl,
      },
      async (identity) => {
        const admissionPolicy = await resolveEffectiveAdmissionPolicy(
          admissionPolicyConfigFromEnv(env),
          new AdmissionPolicyStore(ctx.db)
        );
        const attestedEmail = isEmailAttestingProvider(identity.provider)
          ? normalizeEmail(identity.providerEmail)
          : null;
        admissionPolicy.requireBotEnrollment(attestedEmail ? [attestedEmail] : []);
      }
    );
    const knownActor: KnownActor = { ...actor, canonicalUserId: user.id };
    // Enrolled by a concurrent request after this one authenticated (#2470):
    // apply claims exactly as for an actor known at authentication.
    if (user.outcome === "existing" && claims) {
      await claimKnownActorProfile(ctx, knownActor, claims);
    }
    ctx.principal = {
      ...principal,
      actor: knownActor,
    };
    return null;
  } catch (cause) {
    if (cause instanceof AdmissionDeniedError) {
      logger.warn("Refused to enroll a service actor outside workspace admission", {
        event: "auth.service_actor_admission_denied",
        provider: principal.actor.provider,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return {
        response: json(
          {
            error:
              "Your account is not authorized to join this workspace. Sign in on the web or ask an administrator to check the admission allowlists.",
            code: ACTOR_ADMISSION_DENIED_CODE,
          },
          403
        ),
      };
    }
    logger.error("Failed to finalize verified service actor", {
      event: "auth.service_actor_resolution_failed",
      error: cause instanceof Error ? cause : String(cause),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return authorizationUnavailable();
  }
}

/**
 * A known actor's identity is final, so its route's claims can only complete
 * the profile. Best effort and never a denial: the handler still answers for
 * the body, so a body the route would refuse just writes nothing.
 */
async function completeKnownActorProfile(
  policy: RouteAdmissionPolicy,
  request: Request,
  ctx: RequestContext,
  actor: KnownActor
): Promise<void> {
  if (!policy.serviceActorClaims) return;
  let prepared: ServiceActorClaimsResult;
  try {
    prepared = await policy.serviceActorClaims(request.clone(), ctx);
  } catch (cause) {
    return warnProfileClaimFailed(ctx, cause);
  }
  if (prepared.kind === "claims") await claimKnownActorProfile(ctx, actor, prepared.claims);
}

async function claimKnownActorProfile(
  ctx: RequestContext,
  actor: KnownActor,
  claims: ActorProfileClaims
): Promise<void> {
  try {
    const profileClaim = new KnownActorProfileClaim(
      new UserStore(ctx.db),
      new IdentityClaimStore(ctx.db)
    );
    await profileClaim.claim(actor, claims);
  } catch (cause) {
    warnProfileClaimFailed(ctx, cause);
  }
}

function warnProfileClaimFailed(ctx: RequestContext, cause: unknown): void {
  logger.warn("Failed to complete known service actor profile", {
    event: "auth.service_actor_profile_failed",
    error: cause instanceof Error ? cause : String(cause),
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });
}
