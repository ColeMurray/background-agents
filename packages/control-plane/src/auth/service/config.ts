import type { ServiceName } from "@open-inspect/shared/service-auth";

/** The per-service verification keys held by the control plane. */
export interface ServiceKeyEnv {
  SERVICE_AUTH_SECRET_WEB?: string;
  SERVICE_AUTH_SECRET_SLACK_BOT?: string;
  SERVICE_AUTH_SECRET_GITHUB_BOT?: string;
  SERVICE_AUTH_SECRET_LINEAR_BOT?: string;
  SERVICE_AUTH_SECRET_EXPORT?: string;
  /** The only actor the export service may act as, e.g. `github:12345`. */
  SERVICE_AUTH_EXPORT_ACTOR?: string;
  /** The canonical `users.id` that actor must still belong to. */
  SERVICE_AUTH_EXPORT_USER_ID?: string;
}

/** The one actor a pinned service may act as. */
export interface PinnedActor {
  actor: string;
  /** Canonical user the actor's identity must still map to, so a user merge fails closed. */
  userId: string;
}

/** What the control plane needs to verify one service's requests. */
export interface ServiceCredential {
  secret: string;
  /** Set only for pinned services (see `SERVICE_PROFILES`). */
  pinnedActor?: PinnedActor;
}

function sharedSecret(secret: string | undefined): ServiceCredential | null {
  return secret ? { secret } : null;
}

/**
 * Resolve the credential for one service, or null when it has none. A pinned
 * service resolves only when its secret and its whole pin are set.
 */
export function serviceCredential(
  env: ServiceKeyEnv,
  service: ServiceName
): ServiceCredential | null {
  switch (service) {
    case "web":
      return sharedSecret(env.SERVICE_AUTH_SECRET_WEB);
    case "slack-bot":
      return sharedSecret(env.SERVICE_AUTH_SECRET_SLACK_BOT);
    case "github-bot":
      return sharedSecret(env.SERVICE_AUTH_SECRET_GITHUB_BOT);
    case "linear-bot":
      return sharedSecret(env.SERVICE_AUTH_SECRET_LINEAR_BOT);
    case "export": {
      const secret = env.SERVICE_AUTH_SECRET_EXPORT;
      const actor = env.SERVICE_AUTH_EXPORT_ACTOR;
      const userId = env.SERVICE_AUTH_EXPORT_USER_ID;
      return secret && actor && userId ? { secret, pinnedActor: { actor, userId } } : null;
    }
  }
}
