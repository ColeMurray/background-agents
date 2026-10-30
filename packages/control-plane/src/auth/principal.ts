/**
 * The verified identity behind a control-plane request.
 *
 * Every non-public request resolves to exactly one `Principal` before its
 * handler runs. The shapes make illegal states unrepresentable: only service
 * principals can carry asserted actors, and user principals always carry a
 * resolved identity.
 */

import type { PermissionId } from "@open-inspect/shared/rbac";
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
  /**
   * A personal access token acts as its owner, `userId`, but only within `grant`: admission
   * intersects the owner's permissions with it. It is a distinct kind so a route admits it only
   * by declaring so, never because it accepts users.
   */
  | {
      kind: "personal-access-token";
      userId: string;
      tokenId: string;
      grant: readonly PermissionId[];
    }
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
 * The canonical `users.id` a principal acts as, or null when it acts as no one. A personal access
 * token acts as its owner; a service as the actor it asserted, once that actor is enrolled.
 */
export function canonicalUserIdOf(principal: Principal | undefined): string | null {
  if (!principal) return null;
  switch (principal.kind) {
    case "user":
    case "personal-access-token":
      return principal.userId;
    case "service":
      return principal.actor?.canonicalUserId ?? null;
    case "sandbox":
      return null;
  }
}
