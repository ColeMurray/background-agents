/**
 * The verified identity behind a control-plane request.
 *
 * Every non-public request resolves to exactly one `Principal` before its
 * handler runs. The shapes make illegal states unrepresentable: only service
 * principals can carry asserted actors, and user principals always carry a
 * resolved identity.
 */

import type { ServiceName } from "@open-inspect/shared/service-auth";
import type { SpawnSource } from "@open-inspect/shared/types/sessions";

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
  /** `sandboxId` is the authenticated sandbox's id when the session runtime reported it. */
  | { kind: "sandbox"; sessionId: string; sandboxId?: string | null };

/**
 * Who a service may act as.
 *
 * - `none`: no actor. Web's identity arrives by token exchange, never assertion.
 * - `asserted`: any actor in the namespace; unknown actors enroll on first use.
 * - `pinned`: only the actor its operator configured, which must already exist
 *   and still belong to the configured user (see `ServiceCredential`).
 */
export type ServiceActorPolicy =
  | { kind: "none" }
  | { kind: "asserted"; namespace: ActorNamespace }
  | { kind: "pinned"; namespace: ActorNamespace };

export interface ServiceProfile {
  actor: ServiceActorPolicy;
  /**
   * `actor-routes`: any route whose service authorization admits service actors.
   * `opt-in`: only routes that list the service in `optInServices`.
   */
  routeAccess: "actor-routes" | "opt-in";
  /** Recorded on sessions the service creates; null when it never creates any. */
  spawnSource: SpawnSource | null;
}

/** Per-service authentication, route-access and provenance rules. */
export const SERVICE_PROFILES = {
  web: { actor: { kind: "none" }, routeAccess: "actor-routes", spawnSource: "user" },
  "slack-bot": {
    actor: { kind: "asserted", namespace: "slack" },
    routeAccess: "actor-routes",
    spawnSource: "slack-bot",
  },
  "github-bot": {
    actor: { kind: "asserted", namespace: "github" },
    routeAccess: "actor-routes",
    spawnSource: "github-bot",
  },
  "linear-bot": {
    actor: { kind: "asserted", namespace: "linear" },
    routeAccess: "actor-routes",
    spawnSource: "linear-bot",
  },
  // Unattended trace export (docs/TRACE_EXPORT.md): reads sessions as one
  // configured user and never creates them.
  export: {
    actor: { kind: "pinned", namespace: "github" },
    routeAccess: "opt-in",
    spawnSource: null,
  },
} as const satisfies Record<ServiceName, ServiceProfile>;

type Profiles = typeof SERVICE_PROFILES;

/** Services that assert their own actors: the only ones a route may name or grant. */
export type BotServiceName = {
  [S in ServiceName]: Profiles[S]["actor"]["kind"] extends "asserted" ? S : never;
}[ServiceName];

/** Services admitted only by routes that list them in `optInServices`. */
export type OptInServiceName = {
  [S in ServiceName]: Profiles[S]["routeAccess"] extends "opt-in" ? S : never;
}[ServiceName];
