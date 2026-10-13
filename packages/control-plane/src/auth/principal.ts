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
  /** `sandboxId` is the authenticated sandbox's id when the session runtime reported it. */
  | { kind: "sandbox"; sessionId: string; sandboxId?: string | null };

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

/**
 * Whether this principal acts as a canonical user in its own right: a browser
 * user, or an access token, which is its owner. Both carry `users.id`
 * directly, so ownership and self-scoped permission checks are defined for
 * them. A service principal acts for an asserted actor and a sandbox for no
 * one, which is why neither is included.
 */
export function isSelfActingPrincipal(
  principal: Principal | undefined
): principal is Extract<Principal, { kind: "user" | "access-token" }> {
  return principal?.kind === "user" || principal?.kind === "access-token";
}

/** Methods a read-only credential may use. */
const READ_ONLY_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/**
 * Whether a route admits an access token's mutating methods.
 *
 * `deny`, the default everywhere, is what makes the credential read-only. A
 * route declares `allow` only when it wants the token to write, and only when
 * its handler resolves its subject through `canonicalUserIdOf` rather than
 * requiring a browser-authenticated human.
 */
export type AccessTokenWrites = "allow" | "deny";

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
 * Safe methods are the default rather than a route allowlist because every
 * mutating route is already a non-GET, and an allowlist silently fails open
 * for each read route added later. Routes that want a token to write — skill
 * import, automation create, and manual automation trigger, so the MCP server
 * can manage and run its owner's automations — opt in one at a time through
 * their own policy, which keeps the exceptions enumerable and states them next
 * to the permission the write already demands. Every opt-in so far is
 * additive: it adds a skill revision, an automation, or a run, and destroys
 * nothing, which is the bar a new one has to clear. The opt-in narrows what a
 * leaked token reaches to those routes; everything else stays refused whoever
 * built the request.
 */
export function principalMayUseMethod(
  principal: Principal,
  method: string,
  accessTokenWrites: AccessTokenWrites = "deny"
): boolean {
  if (principal.kind !== "access-token") return true;
  if (accessTokenWrites === "allow") return true;
  return READ_ONLY_METHODS.has(method.toUpperCase());
}
