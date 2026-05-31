import type { SpawnSource } from "@open-inspect/shared";
import { UserScmTokenStore } from "../db/user-scm-tokens";
import type { ProviderIdentity, UserStore } from "../db/user-store";
import type { Env } from "../types";

export interface GitHubEnrichment {
  scmUserId: string;
  scmLogin?: string;
  displayName?: string;
  email?: string;
  accessTokenEncrypted?: string;
  refreshTokenEncrypted?: string;
  tokenExpiresAt?: number;
}

export interface SessionIdentityFields {
  userId?: string;
  spawnSource?: SpawnSource;
  scmUserId?: string;
  scmLogin?: string;
  scmName?: string;
  scmEmail?: string;
  scmAvatarUrl?: string;
  actorUserId?: string;
  actorDisplayName?: string;
  actorEmail?: string;
  actorAvatarUrl?: string;
}

/**
 * Derives a ProviderIdentity from spawnSource and the request body.
 * For GitHub-based callers (web + github-bot), reuses existing scm* fields.
 * For Slack/Linear bots, uses the actor* fields.
 *
 * Returns null when the caller hasn't supplied the required provider-specific
 * ID (scmUserId for GitHub, actorUserId for Slack/Linear). This is expected
 * during the phased rollout: Phase 2 wires this plumbing, Phase 4 updates
 * each bot to send identity fields. Until then, bot sessions get user_id = NULL.
 */
export function resolveProviderIdentity(
  spawnSource: SpawnSource,
  body: SessionIdentityFields
): ProviderIdentity | null {
  switch (spawnSource) {
    case "user":
    case "github-bot":
      return body.scmUserId
        ? {
            provider: "github",
            providerUserId: body.scmUserId,
            providerLogin: body.scmLogin,
            providerEmail: body.scmEmail,
            displayName: body.scmName || body.scmLogin,
            avatarUrl: body.scmAvatarUrl,
          }
        : null;

    case "slack-bot":
      return body.actorUserId
        ? {
            provider: "slack",
            providerUserId: body.actorUserId,
            providerEmail: body.actorEmail,
            displayName: body.actorDisplayName,
            avatarUrl: body.actorAvatarUrl,
          }
        : null;

    case "linear-bot":
      return body.actorUserId
        ? {
            provider: "linear",
            providerUserId: body.actorUserId,
            providerEmail: body.actorEmail,
            displayName: body.actorDisplayName,
          }
        : null;

    default:
      return null;
  }
}

/**
 * Parse a bot-format authorId into provider + providerUserId.
 * Returns null for web client authorIds (plain user IDs without a prefix).
 */
export function parseAuthorId(
  authorId: string
): { provider: string; providerUserId: string } | null {
  const match = authorId.match(/^(github|slack|linear):(.+)$/);
  if (!match) return null;
  return { provider: match[1], providerUserId: match[2] };
}

/**
 * Construct the participant user ID used inside a session, matching the format
 * each bot uses for prompt `authorId`. Canonical platform user IDs are the D1
 * user IDs resolved through provider identities.
 */
export function deriveParticipantUserId(body: SessionIdentityFields): string {
  switch (body.spawnSource) {
    case "github-bot":
      return body.scmUserId ? `github:${body.scmUserId}` : "anonymous";
    case "slack-bot":
      return body.actorUserId ? `slack:${body.actorUserId}` : "anonymous";
    case "linear-bot":
      return body.actorUserId ? `linear:${body.actorUserId}` : "anonymous";
    default:
      return body.userId || "anonymous";
  }
}

/**
 * Given a resolved D1 user, find their linked GitHub identity and return
 * enrichment data (display name, email, OAuth tokens). Returns null if no
 * GitHub identity is linked. Parallelizes independent D1 lookups.
 */
export async function resolveGitHubEnrichment(
  env: Env,
  userStore: UserStore,
  userId: string
): Promise<GitHubEnrichment | null> {
  const identities = await userStore.getIdentitiesForUser(userId);
  const githubIdentity = identities.find((i) => i.provider === "github");
  if (!githubIdentity) return null;

  const [user, tokens] = await Promise.all([
    userStore.getUserById(userId),
    env.TOKEN_ENCRYPTION_KEY
      ? new UserScmTokenStore(env.DB, env.TOKEN_ENCRYPTION_KEY).getEncryptedTokens(
          githubIdentity.providerUserId
        )
      : null,
  ]);

  const email =
    githubIdentity.providerEmail ??
    (githubIdentity.providerLogin
      ? `${githubIdentity.providerUserId}+${githubIdentity.providerLogin}@users.noreply.github.com`
      : undefined);

  return {
    scmUserId: githubIdentity.providerUserId,
    scmLogin: githubIdentity.providerLogin ?? undefined,
    displayName: user?.displayName ?? githubIdentity.providerLogin ?? undefined,
    email,
    accessTokenEncrypted: tokens?.accessTokenEncrypted,
    refreshTokenEncrypted: tokens?.refreshTokenEncrypted,
    tokenExpiresAt: tokens?.expiresAt,
  };
}
