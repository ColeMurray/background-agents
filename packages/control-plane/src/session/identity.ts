import {
  formatGitHubNoreplyEmail,
  githubLoginSchema,
} from "@open-inspect/shared/types/github-identity";
import { z } from "zod";
import { encryptToken } from "../auth/crypto";
import { requireTokenEncryptionKey } from "../env-validation";
import type {
  GitHubAccountSelection,
  GitHubCredentialAuthority,
  ProviderAccountSelection,
} from "../source-control/github-credential-authority";
import type { UserStore } from "../db/user-store";
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

const betterAuthAccessTokenSchema = z.object({
  accessToken: z.string().min(1),
  accessTokenExpiresAt: z.coerce.date().optional(),
});

const betterAuthGitHubAccountInfoSchema = z.object({
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

class BetterAuthGitHubAccessTokenUnavailableError extends Error {
  constructor(cause: unknown) {
    super("Better Auth GitHub access token is unavailable", { cause });
    this.name = "BetterAuthGitHubAccessTokenUnavailableError";
  }
}

export interface BetterAuthGitHubEnrichmentDependencies {
  readonly getAccessToken: (selection: ProviderAccountSelection) => Promise<unknown>;
  readonly getAccountInfo: (selection: ProviderAccountSelection) => Promise<unknown>;
  readonly encryptAccessToken: (accessToken: string) => Promise<string>;
}

export async function resolveBetterAuthGitHubAccessToken(
  userId: string,
  account: GitHubAccountSelection,
  getAccessToken: (selection: ProviderAccountSelection) => Promise<unknown>
): Promise<z.infer<typeof betterAuthAccessTokenSchema>> {
  try {
    return betterAuthAccessTokenSchema.parse(
      await getAccessToken({
        providerId: "github",
        accountId: account.subject,
        userId,
      })
    );
  } catch (error) {
    throw new BetterAuthGitHubAccessTokenUnavailableError(error);
  }
}

/**
 * Resolve GitHub attribution and a current provider token from Better Auth.
 *
 * Better Auth owns refresh-token storage and rotation. Session state receives
 * only a re-encrypted, currently valid access token; it never copies the
 * long-lived refresh credential into a second store.
 */
export async function resolveBetterAuthGitHubEnrichment(
  userId: string,
  account: GitHubAccountSelection,
  dependencies: BetterAuthGitHubEnrichmentDependencies
): Promise<GitHubEnrichment> {
  const selection = {
    providerId: "github" as const,
    accountId: account.subject,
    userId,
  };
  const token = await resolveBetterAuthGitHubAccessToken(
    userId,
    account,
    dependencies.getAccessToken
  );
  const profile = betterAuthGitHubAccountInfoSchema.parse(
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
 * Given a resolved D1 user, return attribution for their one linked GitHub
 * identity. Better Auth remains the sole credential authority.
 */
export async function resolveGitHubEnrichment(
  userStore: UserStore,
  userId: string
): Promise<GitHubEnrichment | null> {
  const identities = await userStore.getIdentitiesForUser(userId);
  const githubIdentities = identities.filter((identity) => identity.provider === "github");
  if (githubIdentities.length > 1) {
    throw new Error("User resolves to multiple GitHub provider accounts");
  }
  const githubIdentity = githubIdentities[0];
  if (!githubIdentity) return null;

  const user = await userStore.getUserById(userId);

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
  };
}

/**
 * Select the credential authority associated with the authenticated request.
 *
 * Browser sessions prove account ownership through their session. Service
 * principals use the canonical user established by route admission and may
 * retain identity-only attribution when that user has no usable OAuth token.
 */
export async function resolveGitHubEnrichmentForRequest(
  env: Env,
  userStore: UserStore,
  userId: string,
  authority: GitHubCredentialAuthority
): Promise<GitHubEnrichment | null> {
  const tokenEncryptionKey = requireTokenEncryptionKey(env);
  const accountClient = authority.accountClient;
  const identityEnrichment =
    authority.kind === "service_principal"
      ? await resolveGitHubEnrichment(userStore, userId)
      : undefined;
  const githubAccount =
    authority.kind === "browser_session"
      ? authority.githubAccount
      : identityEnrichment
        ? { subject: identityEnrichment.scmUserId }
        : null;
  if (!githubAccount) return null;

  try {
    return await resolveBetterAuthGitHubEnrichment(userId, githubAccount, {
      getAccessToken: (selection) => accountClient.getAccessToken({ body: selection }),
      getAccountInfo: (selection) => accountClient.accountInfo({ query: selection }),
      encryptAccessToken: (accessToken) => encryptToken(accessToken, tokenEncryptionKey),
    });
  } catch (error) {
    if (
      authority.kind === "service_principal" &&
      error instanceof BetterAuthGitHubAccessTokenUnavailableError
    ) {
      return identityEnrichment ?? null;
    }
    throw error;
  }
}
