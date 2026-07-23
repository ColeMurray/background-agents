/**
 * Identity enforcement: handler-consumed identity derives from the
 * request's verified principal — never from caller-asserted body fields.
 * Forbidden body identity fields are rejected (400) as a permanent invariant
 * guard against body-identity reintroduction.
 *
 * Handlers call `applyIdentityEnforcement` once, right after reading the raw
 * body — it owns the reject → derive → requires-user sequence, so no handler
 * can run the steps out of order or skip one.
 */

import type { AutomationEventSource, ServiceName, SpawnSource } from "@open-inspect/shared";

import { createLogger } from "./../logger";
import { CALLBACK_DESTINATIONS } from "./callback-signing";
import type { Principal, ResolvedIdentity } from "./principal";
import type { UserStore } from "../db/user-store";
import { error, type RequestContext } from "../routes/shared";

const logger = createLogger("identity-enforcement");

/** The route families that consume caller-supplied identity. */
export type IdentityRoute =
  | "session-create"
  | "ws-token"
  | "prompt"
  | "session-lifecycle"
  | "automation-create";

const SPAWNING_FORBIDDEN_FIELDS = [
  "userId",
  "spawnSource",
  "authProvider",
  "authUserId",
  "actorUserId",
  "scmToken",
  "scmRefreshToken",
  "scmUserId",
] as const;

/**
 * Raw-body keys a caller may not send: identity comes from the principal,
 * SCM credentials from server-side enrichment. Checked against raw JSON
 * before Zod because every schema is strip-mode. Display-only fields
 * (authEmail/Name/AvatarUrl, actorDisplayName, scmLogin…) stay body-carried
 * by design.
 */
const FORBIDDEN_IDENTITY_FIELDS: Record<IdentityRoute, readonly string[]> = {
  "session-create": SPAWNING_FORBIDDEN_FIELDS,
  "ws-token": ["userId", "scmToken", "scmRefreshToken", "scmUserId"],
  prompt: ["authorId"],
  "session-lifecycle": ["userId"],
  "automation-create": SPAWNING_FORBIDDEN_FIELDS,
};

/**
 * Routes that mint identity and must fail closed (403) when the principal
 * derives no participant — a user principal is required; bots must assert an
 * actor. Other routes proceed with a null participant (anonymous prompts).
 */
const REQUIRES_USER_MESSAGE = {
  "session-create": "A user identity is required to create a session",
  "ws-token": "A user identity is required for a websocket token",
  "automation-create": "A user identity is required to create an automation",
} as const;

type RequiresUserRoute = keyof typeof REQUIRES_USER_MESSAGE;

function requiresUserMessage(route: IdentityRoute): string | undefined {
  return route in REQUIRES_USER_MESSAGE
    ? REQUIRES_USER_MESSAGE[route as RequiresUserRoute]
    : undefined;
}

/** Identity a verified principal implies for a consuming route. */
export interface DerivedIdentity {
  /** DO participant id: bare canonical id for users, `ns:id` for bot actors. */
  participantUserId: string | null;
  /** Canonical D1 users.id when the principal resolves to one. */
  canonicalUserId: string | null;
  /**
   * The verified bot-asserted actor backing `participantUserId` — what
   * `resolveCanonicalUserId` creates the canonical user from on first sight.
   * Null for user principals (their `canonicalUserId` is always set) and for
   * userless service principals.
   */
  actor: ResolvedIdentity | null;
  /** Session/automation provenance: "user" for web users, the service name for bots; null when the principal never spawns sessions (modal). */
  spawnSource: SpawnSource | null;
}

/**
 * Requires-user routes are guaranteed a participant by the
 * `applyIdentityEnforcement` gate; the type says so, sparing call sites a
 * null check the gate already performed.
 */
export type EnforcedIdentity<R extends IdentityRoute> = R extends RequiresUserRoute
  ? DerivedIdentity & { participantUserId: string }
  : DerivedIdentity;

/**
 * The principal→identity mapping. Returns null when the principal
 * carries no identity semantics for these routes (sandbox principals — the
 * router's sandbox-route allowlist keeps them off identity routes).
 */
export function deriveIdentity(principal: Principal | undefined): DerivedIdentity | null {
  if (!principal) return null;
  switch (principal.kind) {
    case "user":
      return {
        participantUserId: principal.user.participantUserId,
        canonicalUserId: principal.user.canonicalUserId,
        actor: null,
        spawnSource: "user",
      };
    case "service":
      if (principal.service === "web") {
        // Web's userless service credential asserts no one; user-bearing web
        // calls carry a web session token and resolve as user principals.
        return { participantUserId: null, canonicalUserId: null, actor: null, spawnSource: "user" };
      }
      if (principal.service === "modal") {
        return { participantUserId: null, canonicalUserId: null, actor: null, spawnSource: null };
      }
      return {
        participantUserId: principal.actor?.participantUserId ?? null,
        canonicalUserId: principal.actor?.canonicalUserId ?? null,
        actor: principal.actor,
        spawnSource: principal.service,
      };
    case "sandbox":
      return null;
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type IdentityEnforcement<R extends IdentityRoute> =
  | { rejection: Response; enforced?: undefined }
  | { rejection?: undefined; enforced: EnforcedIdentity<R> };

/**
 * The single enforcement entry point for identity-consuming handlers:
 * forbidden-field rejection, identity derivation, and the requires-user gate
 * in the required order. Pass the raw pre-Zod body (any shape — non-objects
 * are treated as bodyless).
 */
export function applyIdentityEnforcement<R extends IdentityRoute>(
  ctx: RequestContext,
  route: R,
  rawBody: unknown
): IdentityEnforcement<R> {
  const body = isJsonObject(rawBody) ? rawBody : null;
  const derived = deriveIdentity(ctx.principal);
  if (!derived) {
    // Unreachable through the router (identity routes accept only user and
    // service principals); fail closed rather than proceed identityless if
    // that ever changes.
    return { rejection: error("A verified user or service identity is required", 403) };
  }
  if (body) {
    for (const field of FORBIDDEN_IDENTITY_FIELDS[route]) {
      if (body[field] !== undefined) {
        logger.warn("Forbidden identity field rejected", {
          event: "identity.forbidden_field_rejected",
          route,
          field,
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
        });
        return { rejection: error(`Field '${field}' is not accepted from verified callers`, 400) };
      }
    }
  }
  const requiresUser = requiresUserMessage(route);
  if (requiresUser && !derived.participantUserId) {
    return { rejection: error(requiresUser, 403) };
  }
  // The requires-user gate above is what EnforcedIdentity<R> encodes; the
  // conditional type cannot be narrowed by control flow, hence the one cast.
  return { enforced: derived as EnforcedIdentity<R> };
}

/**
 * Resolve the canonical `users.id` for a spawning route, creating the user
 * from the VERIFIED actor when the CP has not seen them before (display
 * fields may come from the body — they are cosmetic, never identity). Fails
 * closed with a 500 rather than writing anonymous attribution. Shared by
 * session-create and automation-create so the two routes cannot drift.
 *
 * Takes the requires-user enforced shape: every participant is backed by a
 * canonical user (web users) or a verified actor (bot assertions), so the
 * resolved id is never null.
 */
export async function resolveCanonicalUserId(
  userStore: UserStore,
  ctx: RequestContext,
  enforced: DerivedIdentity & { participantUserId: string },
  display: { displayName?: string; email?: string; avatarUrl?: string }
): Promise<{ userId: string } | Response> {
  if (enforced.canonicalUserId) return { userId: enforced.canonicalUserId };
  const actor = enforced.actor;
  if (!actor) {
    // Unreachable while deriveIdentity holds its invariant (a participant
    // without a canonical user is always actor-backed); fail closed rather
    // than write anonymous attribution if that ever breaks.
    logger.error("Participant carries neither a canonical user nor an actor", {
      participant: enforced.participantUserId,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to resolve session identity", 500);
  }
  try {
    const user = await userStore.resolveOrCreateUser({
      provider: actor.provider,
      providerUserId: actor.providerUserId,
      displayName: display.displayName,
      providerEmail: display.email,
      avatarUrl: display.avatarUrl,
    });
    return { userId: user.id };
  } catch (e) {
    logger.error("Failed to resolve verified actor identity", {
      error: e instanceof Error ? e : String(e),
      provider: actor.provider,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to resolve session identity", 500);
  }
}

/**
 * Whether this principal may attach a `callbackContext` to prompts. Bots
 * that own completion callbacks may; anyone else injecting one is a
 * notification-forgery vector.
 */
export function mayAttachCallbackContext(ctx: RequestContext): boolean {
  const principal = ctx.principal;
  return (
    principal?.kind === "service" &&
    (CALLBACK_DESTINATIONS as readonly ServiceName[]).includes(principal.service)
  );
}

function logMismatchRejected(
  route: string,
  field: string,
  expected: string,
  actual: string,
  ctx: RequestContext
): void {
  logger.warn("Identity mismatch rejected", {
    event: "identity.mismatch_rejected",
    route,
    field,
    expected,
    actual,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });
}

/**
 * The bot service allowed to post each normalized automation event source.
 * `null` marks sources that are not bot-posted (sentry/webhook arrive on the
 * CP's own public webhook surface; linear posts no normalized events today)
 * — an explicit exemption, not a missing row.
 */
const EVENT_SOURCE_SERVICE: Record<AutomationEventSource, ServiceName | null> = {
  slack: "slack-bot",
  github: "github-bot",
  linear: null,
  sentry: null,
  webhook: null,
};

/**
 * Gate for the internal normalized automation-event endpoints: the poster
 * must be a service principal (401 otherwise), and per-service sources
 * accept only the source's own bot. Sources with a null row arrive via the
 * CP's own public webhook surface, so any service may forward them.
 */
export function requireEventPoster(
  ctx: RequestContext,
  source: AutomationEventSource
): Response | null {
  const principal = ctx.principal;
  if (principal?.kind !== "service") {
    return error("Unauthorized", 401);
  }
  const expected = EVENT_SOURCE_SERVICE[source];
  if (expected === null || principal.service === expected) return null;
  logMismatchRejected(`internal-${source}-event`, "service", expected, principal.service, ctx);
  return error("Unauthorized", 401);
}

/**
 * Guard for `PUT /provider-identities/:provider/:id`: a user principal must
 * match the path identity exactly (403 otherwise) — the route has no
 * identity-creating role for them; exchange owns that. Among services, only
 * web may upsert: its BFF resolves identities during the OAuth sign-in flow,
 * before a user token exists. Everyone else is rejected.
 */
export function enforceProviderIdentityPath(
  ctx: RequestContext,
  provider: string,
  providerUserId: string
): Response | null {
  const principal = ctx.principal;
  if (principal?.kind === "user") {
    if (provider === principal.user.provider && providerUserId === principal.user.providerUserId) {
      return null;
    }
    logMismatchRejected(
      "provider-identities",
      "provider-identity-path",
      `${principal.user.provider}:${principal.user.providerUserId}`,
      `${provider}:${providerUserId}`,
      ctx
    );
    return error("Path identity does not match the authenticated user", 403);
  }
  if (principal?.kind === "service" && principal.service === "web") return null;
  logMismatchRejected(
    "provider-identities",
    "principal",
    "matching user or web service",
    principal?.kind === "service" ? principal.service : (principal?.kind ?? "none"),
    ctx
  );
  return error("Only the matching user or the web service may upsert provider identities", 403);
}
