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

import type { SpawnSource } from "@open-inspect/shared/types/sessions";
import type { ServiceName } from "@open-inspect/shared/service-auth";
import { createLogger } from "../logger";
import { CALLBACK_DESTINATIONS } from "../auth/service/callback-signing";
import type { Principal, ResolvedIdentity } from "../auth/principal";
import { error } from "../http/responses";
import type { RequestContext } from "../http/request-context";

const logger = createLogger("identity-enforcement");

/** The route families that consume caller-supplied identity. */
type IdentityRoute = "session-create" | "ws-token" | "prompt" | "automation-create";

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
 * before Zod because every schema is strip-mode. Profile fields
 * (authEmail/Name/AvatarUrl, actorDisplayName, scmLogin…) stay body-carried
 * by design; only admission for a verified Slack/Linear service may treat
 * actorEmail as identity-bearing.
 */
const FORBIDDEN_IDENTITY_FIELDS: Record<IdentityRoute, readonly string[]> = {
  "session-create": SPAWNING_FORBIDDEN_FIELDS,
  "ws-token": ["userId", "scmToken", "scmRefreshToken", "scmUserId"],
  prompt: ["authorId"],
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
interface DerivedIdentity {
  /** DO participant id: bare canonical id for users, `ns:id` for bot actors. */
  participantUserId: string | null;
  /** Canonical D1 users.id when the principal resolves to one. */
  canonicalUserId: string | null;
  /**
   * The verified bot-asserted actor backing `participantUserId` — what route
   * admission uses to finalize the canonical user before RBAC.
   * Null for user principals (their `canonicalUserId` is always set) and for
   * userless service principals.
   */
  actor: ResolvedIdentity | null;
  /** Session/automation provenance: "user" for web users or the service name for bots. */
  spawnSource: SpawnSource | null;
}

/**
 * Requires-user routes are guaranteed a participant by the
 * `applyIdentityEnforcement` gate; the type says so, sparing call sites a
 * null check the gate already performed.
 */
type EnforcedIdentity<R extends IdentityRoute> = R extends RequiresUserRoute
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
        participantUserId: principal.userId,
        canonicalUserId: principal.userId,
        actor: null,
        spawnSource: "user",
      };
    case "service":
      if (principal.service === "web") {
        // Web's userless service credential asserts no one; user-bearing web
        // calls carry a web session token and resolve as user principals.
        return { participantUserId: null, canonicalUserId: null, actor: null, spawnSource: "user" };
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

type IdentityEnforcement<R extends IdentityRoute> =
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
 * Return the canonical subject already admitted by the router. Spawning
 * handlers may never resolve or relink identity after RBAC has run: the user
 * authorized and the user attributed to the side effect must be identical.
 */
export function requireAdmittedCanonicalUserId(
  ctx: RequestContext,
  enforced: DerivedIdentity & { participantUserId: string }
): string | Response {
  const userId = enforced.canonicalUserId;
  if (userId && ctx.authorization?.userId === userId) return userId;

  logger.error("Spawning handler received no matching admitted canonical user", {
    participant: enforced.participantUserId,
    canonical_user_id: userId ?? undefined,
    authorized_user_id: ctx.authorization?.userId,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });
  return error("Failed to resolve session identity", 500);
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
