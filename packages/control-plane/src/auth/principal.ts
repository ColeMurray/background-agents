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
  // Read-only inspection tooling. Asserts nothing: it must never be able to
  // act as a person, so every route it reaches sees a bare service principal.
  mcp: null,
};

/**
 * Services whose credential may only ever read.
 *
 * `mcp` runs on an operator's machine rather than inside the deployment, so
 * its secret is the one most likely to leak — and a leaked secret is only as
 * dangerous as the routes it can reach. Restricting it to safe methods here,
 * at the router, is what makes "read-only" a property of the credential
 * rather than of whichever client happens to hold it: the same signature on a
 * `DELETE /sessions/:id` or `PUT /secrets` is refused whoever built it.
 *
 * Safe methods are the boundary rather than a route allowlist because every
 * mutating route is already a non-GET, and an allowlist silently fails open
 * for each read route added later.
 */
export const READ_ONLY_SERVICES: ReadonlySet<ServiceName> = new Set<ServiceName>(["mcp"]);

/** Methods a read-only service credential may use. */
const READ_ONLY_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/** Whether this principal may issue a request with this method. */
export function principalMayUseMethod(principal: Principal, method: string): boolean {
  if (principal.kind !== "service" || !READ_ONLY_SERVICES.has(principal.service)) return true;
  return READ_ONLY_METHODS.has(method.toUpperCase());
}
