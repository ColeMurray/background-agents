/**
 * The verified identity behind a control-plane request.
 *
 * Every non-public request resolves to exactly one `Principal` before its
 * handler runs. The shapes make illegal states unrepresentable: only service
 * principals can carry asserted actors, and user principals always carry a
 * resolved identity.
 */

import type { ServiceName } from "@open-inspect/shared";

/** Actor namespaces bots may assert (`slack:U123` etc.). */
export const ACTOR_NAMESPACES = ["slack", "github", "linear"] as const;
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

export type Principal =
  | { kind: "user"; user: ResolvedIdentity; tokenId: string }
  | { kind: "service"; service: ServiceName; actor: ResolvedIdentity | null }
  | { kind: "sandbox"; sessionId: string };

/**
 * The actor namespace each service may assert. Web and Modal assert none —
 * web identity arrives by token exchange, never assertion, and the Modal
 * scheduler acts for no one.
 */
export const ASSERTION_RIGHTS: Record<ServiceName, ActorNamespace | null> = {
  web: null,
  "slack-bot": "slack",
  "github-bot": "github",
  "linear-bot": "linear",
  modal: null,
};
