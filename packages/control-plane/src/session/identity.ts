import {
  formatGitHubNoreplyEmail,
  githubLoginSchema,
} from "@open-inspect/shared/types/github-identity";
import { z } from "zod";
import type {
  GitHubCredentialAuthority,
  ProviderAccountSelection,
  ProviderAccountClient,
} from "../source-control/github-credential-authority";
import type { UserStore } from "../db/user-store";
import type { SourceControlProviderName } from "../source-control";

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
}

const GITHUB_ACCESS_TOKEN_EXPIRY_BUFFER_MS = 60_000;

const betterAuthAccessTokenSchema = z.object({
  accessToken: z.string(),
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

export class BetterAuthGitHubTokenUnavailableError extends Error {
  constructor(readonly retrievalError: unknown) {
    super("Better Auth GitHub token is unavailable", { cause: retrievalError });
    this.name = "BetterAuthGitHubTokenUnavailableError";
  }
}

function expiresWithinGitHubSafetyWindow(token: { accessTokenExpiresAt?: Date }): boolean {
  return Boolean(
    token.accessTokenExpiresAt &&
    token.accessTokenExpiresAt.getTime() <= Date.now() + GITHUB_ACCESS_TOKEN_EXPIRY_BUFFER_MS
  );
}

function parseBetterAuthGitHubProfile(response: unknown, expectedScmUserId: string) {
  const profile = betterAuthGitHubAccountInfoSchema.parse(response);
  if (profile.user.id !== expectedScmUserId || profile.data.subject !== expectedScmUserId) {
    throw new Error("Better Auth returned a mismatched GitHub account");
  }
  return profile.data;
}

/** Resolve current PR credentials without copying Better Auth tokens into session state. */
export async function resolveCurrentGitHubAccessToken(
  userStore: UserStore,
  getAccountClient: () => ProviderAccountClient,
  canonicalUserId: string,
  expectedScmUserId: string
): Promise<string | null> {
  const enrichment = await resolveGitHubEnrichment(userStore, canonicalUserId);
  if (!enrichment) return null;
  if (enrichment.scmUserId !== expectedScmUserId) {
    throw new Error("Session GitHub account no longer matches the canonical user");
  }

  const selection: ProviderAccountSelection = {
    providerId: "github",
    accountId: expectedScmUserId,
    userId: canonicalUserId,
  };
  const accountClient = getAccountClient();
  let tokenResponse: unknown;
  try {
    tokenResponse = await accountClient.getAccessToken({ body: selection });
  } catch (error) {
    throw new BetterAuthGitHubTokenUnavailableError(error);
  }
  let token = betterAuthAccessTokenSchema.parse(tokenResponse);
  if (token.accessToken === "") return null;

  if (expiresWithinGitHubSafetyWindow(token)) {
    let refreshResponse: unknown;
    try {
      refreshResponse = await accountClient.refreshToken({ body: selection });
    } catch (error) {
      throw new BetterAuthGitHubTokenUnavailableError(error);
    }
    token = betterAuthAccessTokenSchema.parse(refreshResponse);
    if (token.accessToken === "") {
      throw new Error("Better Auth returned an empty refreshed GitHub access token");
    }
    if (expiresWithinGitHubSafetyWindow(token)) return null;
  }

  parseBetterAuthGitHubProfile(
    await accountClient.accountInfo({ query: selection }),
    expectedScmUserId
  );
  return token.accessToken;
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
 * principals use the canonical user established by route admission. Tokens
 * remain in Better Auth and are resolved only at the final provider boundary.
 */
export async function resolveGitHubEnrichmentForRequest(
  userStore: UserStore,
  userId: string,
  authority: GitHubCredentialAuthority
): Promise<GitHubEnrichment | null> {
  const enrichment = await resolveGitHubEnrichment(userStore, userId);
  if (authority.kind === "service_principal") return enrichment;

  if (!authority.githubAccount) {
    if (enrichment) throw new Error("GitHub account authority is corrupt");
    return null;
  }
  if (!enrichment || enrichment.scmUserId !== authority.githubAccount.subject) {
    throw new Error("GitHub account authority is corrupt");
  }
  if (enrichment.scmLogin) return enrichment;

  const profileResponse = await authority.githubAccount.resolveProfile();
  if (profileResponse === null) return enrichment;
  const profile = parseBetterAuthGitHubProfile(profileResponse, authority.githubAccount.subject);
  const displayName = enrichment.displayName ?? profile.displayName ?? profile.login;
  const authorIdentity = resolveGitAuthorIdentity({
    scmProvider: "github",
    scmUserId: enrichment.scmUserId,
    scmLogin: profile.login,
    scmName: displayName,
  });
  return {
    ...enrichment,
    scmLogin: profile.login,
    displayName,
    email: authorIdentity?.email,
  };
}
