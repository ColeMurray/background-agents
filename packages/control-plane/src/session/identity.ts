import { formatGitHubNoreplyEmail, githubLoginSchema } from "@open-inspect/shared";
import { UserScmTokenStore } from "../db/user-scm-tokens";
import type { UserStore } from "../db/user-store";
import type { SourceControlProviderName } from "../source-control";
import type { Env } from "../types";
import type { SqlDatabase } from "../db/sql-database";

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
 * Given a resolved D1 user, find their linked GitHub identity and return
 * enrichment data (display name, email, OAuth tokens). Returns null if no
 * GitHub identity is linked. Parallelizes independent D1 lookups.
 */
export async function resolveGitHubEnrichment(
  env: Env,
  db: SqlDatabase,
  userStore: UserStore,
  userId: string
): Promise<GitHubEnrichment | null> {
  const identities = await userStore.getIdentitiesForUser(userId);
  const githubIdentity = identities.find((i) => i.provider === "github");
  if (!githubIdentity) return null;

  const [user, tokens] = await Promise.all([
    userStore.getUserById(userId),
    env.TOKEN_ENCRYPTION_KEY
      ? new UserScmTokenStore(db, env.TOKEN_ENCRYPTION_KEY).getEncryptedTokens(
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
