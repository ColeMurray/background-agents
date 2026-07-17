import {
  formatGitHubNoreplyEmail,
  githubLoginSchema,
  type SpawnSource,
} from "@open-inspect/shared";
import { UserScmTokenStore } from "../db/user-scm-tokens";
import type { ProviderIdentity, UserStore } from "../db/user-store";
import type { SourceControlProviderName } from "../source-control";
import type { Env } from "../types";

const FALLBACK_GIT_AUTHOR = {
  name: "OpenInspect",
  email: "open-inspect@noreply.github.com",
} as const;

export interface GitAuthorIdentity {
  name: string;
  email: string;
}

export interface GitAuthorIdentityInput {
  scmProvider: SourceControlProviderName;
  scmUserId?: string | null;
  scmLogin?: string | null;
  scmName?: string | null;
  scmEmail?: string | null;
}

export function resolveGitAuthorIdentity(input: GitAuthorIdentityInput): GitAuthorIdentity | null {
  if (input.scmProvider !== "github") {
    return {
      name: input.scmName?.trim() || FALLBACK_GIT_AUTHOR.name,
      email: input.scmEmail?.trim() || FALLBACK_GIT_AUTHOR.email,
    };
  }

  const login = githubLoginSchema.safeParse(input.scmLogin);
  if (!input.scmUserId || !/^[1-9]\d*$/.test(input.scmUserId) || !login.success) {
    return null;
  }

  return {
    name: input.scmName?.trim() || login.data,
    email: formatGitHubNoreplyEmail({ id: input.scmUserId, login: login.data }),
  };
}

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

  // Provider-agnostic authentication identity — "who logged in". The web client
  // populates this for every auth provider (GitHub or Google); it resolves the
  // canonical D1 user. Kept separate from scm* (GitHub-only SCM credentials and
  // git-commit attribution) so a pure-Google session carries auth* and no scm*.
  authProvider?: "github" | "google";
  authUserId?: string;
  authEmail?: string;
  authName?: string;
  authAvatarUrl?: string;

  // GitHub SCM credentials + git-commit attribution (GitHub-only, optional).
  scmUserId?: string;
  scmLogin?: string;
  scmName?: string;
  scmEmail?: string;
  scmAvatarUrl?: string;

  // Slack / Linear bot actor identity.
  actorUserId?: string;
  actorDisplayName?: string;
  actorEmail?: string;
  actorAvatarUrl?: string;
}

/**
 * Derives a ProviderIdentity from spawnSource and the request body.
 *
 * - Web users (spawnSource "user"): the provider-agnostic auth* block identifies
 *   who logged in (GitHub or Google). Falls back to scm* so that in-flight
 *   old-web payloads — which send only scm* and no auth* during the rollout
 *   window — still resolve to a user_id.
 * - github-bot: GitHub identity from scm* fields.
 * - Slack / Linear bots: actor* fields.
 *
 * Returns null when the caller hasn't supplied the required provider-specific ID
 * (authUserId/scmUserId for web users, scmUserId for github-bot, actorUserId for
 * Slack/Linear). Such sessions get user_id = NULL.
 */
export function resolveProviderIdentity(
  spawnSource: SpawnSource,
  body: SessionIdentityFields
): ProviderIdentity | null {
  switch (spawnSource) {
    case "user": {
      // Web users (GitHub or Google). Identity comes from the auth* block; we
      // fall back to scm* only for old-web payloads that predate auth* (always
      // GitHub). provider and providerUserId are taken from the SAME source so a
      // malformed payload can't pair a Google id with provider "github", and the
      // discriminator is allowlisted (fail closed) rather than persisted raw —
      // mirroring the /provider-identities/:provider route guard.
      if (body.authUserId) {
        if (body.authProvider !== "github" && body.authProvider !== "google") return null;
        return {
          provider: body.authProvider,
          providerUserId: body.authUserId,
          providerLogin: body.scmLogin,
          providerEmail: body.authEmail ?? body.scmEmail,
          displayName: body.authName ?? (body.scmName || body.scmLogin),
          avatarUrl: body.authAvatarUrl ?? body.scmAvatarUrl,
        };
      }
      if (!body.scmUserId) return null;
      return {
        provider: "github",
        providerUserId: body.scmUserId,
        providerLogin: body.scmLogin,
        providerEmail: body.scmEmail,
        displayName: body.scmName || body.scmLogin,
        avatarUrl: body.scmAvatarUrl,
      };
    }

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

  const authorIdentity = resolveGitAuthorIdentity({
    scmProvider: "github",
    scmUserId: githubIdentity.providerUserId,
    scmLogin: githubIdentity.providerLogin,
    scmName: user?.displayName,
    scmEmail: githubIdentity.providerEmail,
  });

  return {
    scmUserId: githubIdentity.providerUserId,
    scmLogin: githubIdentity.providerLogin ?? undefined,
    displayName: user?.displayName ?? githubIdentity.providerLogin ?? undefined,
    email: authorIdentity?.email ?? undefined,
    accessTokenEncrypted: tokens?.accessTokenEncrypted,
    refreshTokenEncrypted: tokens?.refreshTokenEncrypted,
    tokenExpiresAt: tokens?.expiresAt,
  };
}
