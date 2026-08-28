/**
 * The verified identity behind a control-plane request.
 *
 * Every non-public request resolves to exactly one `Principal` before its
 * handler runs. The shapes make illegal states unrepresentable: only service
 * principals can carry asserted actors, and user principals always carry a
 * resolved identity.
 */

import type { ServiceName } from "@open-inspect/shared/service-auth";

/** Actor namespaces bots may assert (`slack:U123` etc.). */
const ACTOR_NAMESPACES = ["slack", "github", "linear"] as const;
export type ActorNamespace = (typeof ACTOR_NAMESPACES)[number];

export function isActorNamespace(value: string): value is ActorNamespace {
  return (ACTOR_NAMESPACES as readonly string[]).includes(value);
}

export interface ResolvedIdentity {
  provider: "github" | "google" | "slack" | "linear";
  providerUserId: string;
  /** Canonical D1 `users.id`. Always set for user principals; null for actors the CP has never seen. */
  canonicalUserId: string | null;
  /** DO participant format: bare id for web users, `ns:id` for bot actors. */
  participantUserId: string;
}

/** Provider-independent evidence used to authenticate a browser request. */
export interface AuthenticationContext {
  mechanism: "browser_session";
  credentialId: string;
  channel: {
    kind: "sig1";
    service: "web";
  };
}

export type Principal =
  | { kind: "user"; userId: string }
  | { kind: "access-token"; userId: string; tokenId: string }
  | { kind: "service"; service: ServiceName; actor: ResolvedIdentity | null }
  | { kind: "sandbox"; sessionId: string };

/**
 * The actor namespace each service may assert. Web asserts none because its
 * identity arrives by token exchange, never assertion.
 */
export const ASSERTION_RIGHTS: Record<ServiceName, ActorNamespace | null> = {
  web: null,
  "slack-bot": "slack",
  "github-bot": "github",
  "linear-bot": "linear",
};

/**
 * The canonical `users.id` a principal acts as, or null when it acts as no
 * one. An access token is its owner, so it resolves exactly as that user
 * would — the point of the credential is that its requests are attributable.
 */
export function canonicalUserIdOf(principal: Principal | undefined): string | null {
  if (!principal) return null;
  switch (principal.kind) {
    case "user":
    case "access-token":
      return principal.userId;
    case "service":
      return principal.actor?.canonicalUserId ?? null;
    case "sandbox":
      return null;
  }
}

/** Methods a read-only credential may use. */
const READ_ONLY_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/**
 * Whether this principal may issue a request with this method.
 *
 * An access token is the one credential that lives outside the deployment —
 * on a laptop, in an MCP client's config — so it is the one most likely to
 * leak, and a leaked credential is only as dangerous as the routes it can
 * reach. Restricting it to safe methods here, at the router, makes read-only a
 * property of the credential rather than of whichever client holds it: the
 * same token on a `DELETE /sessions/:id` or `PUT /secrets` is refused whoever
 * built the request.
 *
 * Safe methods are the boundary rather than a route allowlist because every
 * mutating route is already a non-GET, and an allowlist silently fails open
 * for each read route added later.
 */
export function principalMayUseMethod(principal: Principal, method: string): boolean {
  if (principal.kind !== "access-token") return true;
  return READ_ONLY_METHODS.has(method.toUpperCase());
}
