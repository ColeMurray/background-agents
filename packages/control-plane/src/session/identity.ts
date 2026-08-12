import {
  formatGitHubNoreplyEmail,
  githubLoginSchema,
} from "@open-inspect/shared/types/github-identity";
import { z } from "zod";
import { encryptToken } from "../auth/crypto";
import type {
  GitHubAccountSelection,
  GitHubCredentialAuthority,
} from "../source-control/github-credential-authority";
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

const browserAccessTokenSchema = z.object({
  accessToken: z.string().min(1),
  accessTokenExpiresAt: z.coerce.date().optional(),
});

const browserGitHubAccountInfoSchema = z.object({
  user: z.object({
    id: z.string().min(1),
  }),
  data: z.object({
    provider: z.literal("github"),
    issuer: z.literal("https://github.com"),
    subject: z.string().min(1),
    login: githubLoginSchema,
    displayName: z.string().min(1).optional(),
    verifiedEmails: z.array(z.string()),
    primaryEmail: z.string().nullable(),
  }),
});

export interface BrowserGitHubEnrichmentDependencies {
  readonly getAccessToken: (selection: {
    providerId: "github";
    accountId: string;
    userId: string;
  }) => Promise<unknown>;
  readonly getAccountInfo: (selection: {
    providerId: "github";
    accountId: string;
    userId: string;
  }) => Promise<unknown>;
  readonly encryptAccessToken: (accessToken: string) => Promise<string>;
}

/**
 * Resolve GitHub attribution and a current provider token from Better Auth.
 *
 * Better Auth owns refresh-token storage and rotation. Session state receives
 * only a re-encrypted, currently valid access token; it never copies the
 * long-lived refresh credential into a second store.
 */
export async function resolveBrowserGitHubEnrichment(
  userId: string,
  account: GitHubAccountSelection,
  dependencies: BrowserGitHubEnrichmentDependencies
): Promise<GitHubEnrichment> {
  const selection = {
    providerId: "github" as const,
    accountId: account.subject,
    userId,
  };
  const token = browserAccessTokenSchema.parse(await dependencies.getAccessToken(selection));
  const profile = browserGitHubAccountInfoSchema.parse(
    await dependencies.getAccountInfo(selection)
  );
  if (profile.user.id !== account.subject || profile.data.subject !== account.subject) {
    throw new Error("Better Auth returned a mismatched GitHub account");
  }

  const accessTokenEncrypted = await dependencies.encryptAccessToken(token.accessToken);
  const author = resolveGitAuthorIdentity({
    scmProvider: "github",
    scmUserId: profile.data.subject,
    scmLogin: profile.data.login,
    scmName: profile.data.displayName,
    scmEmail: profile.data.primaryEmail,
  });

  return {
    scmUserId: profile.data.subject,
    scmLogin: profile.data.login,
    displayName: profile.data.displayName ?? profile.data.login,
    email: author?.email,
    accessTokenEncrypted,
    ...(token.accessTokenExpiresAt ? { tokenExpiresAt: token.accessTokenExpiresAt.getTime() } : {}),
  };
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

/**
 * Select the credential authority associated with the authenticated request.
 *
 * Browser sessions read/refresh through Better Auth. Bot identities retain
 * their existing actor identity/token-store lookup.
 */
export async function resolveGitHubEnrichmentForRequest(
  env: Env,
  db: SqlDatabase,
  userStore: UserStore,
  userId: string,
  authority: GitHubCredentialAuthority
): Promise<GitHubEnrichment | null> {
  if (authority.kind === "legacy") {
    return resolveGitHubEnrichment(env, db, userStore, userId);
  }

  const accountClient = authority.accountClient;
  const githubAccount = authority.githubAccount;
  if (!githubAccount) return null;
  return resolveBrowserGitHubEnrichment(userId, githubAccount, {
    getAccessToken: (selection) => accountClient.getAccessToken({ body: selection }),
    getAccountInfo: (selection) => accountClient.accountInfo({ query: selection }),
    encryptAccessToken: (accessToken) => encryptToken(accessToken, env.TOKEN_ENCRYPTION_KEY),
  });
}
