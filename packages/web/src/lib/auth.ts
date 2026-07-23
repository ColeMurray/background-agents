import type { Account, NextAuthOptions, Profile, Session } from "next-auth";
import type { JWT } from "next-auth/jwt";
import GitHubProvider from "next-auth/providers/github";
import type { GithubProfile } from "next-auth/providers/github";
import GoogleProvider from "next-auth/providers/google";
import { z } from "zod";
import { DEFAULT_APP_NAME } from "@open-inspect/shared";
import {
  type AccessAllowReason,
  type AccessControlConfig,
  getAccessAllowReason,
  parseAllowlist,
  parseBooleanEnv,
} from "./access-control";
import {
  checkGitHubOrganizationAccess,
  type GitHubOrganizationAccessResult,
} from "./github-org-membership";
import { type AuthProvider, isAuthProvider } from "./build-auth-identity";
import { applyOiSessionTokens } from "./oi-session";
import { githubEmailListSchema, type GitHubEmail } from "./github-email-schema";

const GITHUB_EMAIL_FETCH_TIMEOUT_MS = 5_000;

interface GitHubEmailFetchParams {
  accessToken: string | undefined;
  fetchImpl?: typeof fetch;
  userAgent?: string;
  timeoutMs?: number;
}

const githubUserInfoProfileSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    login: z.string(),
    email: z.string().nullable().optional(),
  })
  .passthrough();

type GitHubUserInfoProfile = z.infer<typeof githubUserInfoProfileSchema> & {
  email: string | null;
  verifiedEmails: GitHubEmail[];
};

type ProfileWithVerifiedEmails = Profile & { verifiedEmails?: GitHubEmail[] };

export function normalizeGitHubUserInfoProfile(
  profile: unknown,
  verifiedEmails: GitHubEmail[]
): GitHubUserInfoProfile | null {
  const result = githubUserInfoProfileSchema.safeParse(profile);
  if (!result.success) {
    return null;
  }

  return {
    ...result.data,
    email: verifiedEmails.find((e) => e.primary)?.email ?? null,
    verifiedEmails,
  };
}

/**
 * Fetch verified email addresses from GitHub's API.
 *
 * Returns all verified emails for the authenticated user. If the access token
 * is missing or the request fails, returns an empty array (fails closed).
 * Requests are aborted after the timeout to prevent hanging.
 */
export async function getVerifiedGitHubEmails({
  accessToken,
  fetchImpl = fetch,
  userAgent = "Open-Inspect",
  timeoutMs = GITHUB_EMAIL_FETCH_TIMEOUT_MS,
}: GitHubEmailFetchParams): Promise<GitHubEmail[]> {
  if (!accessToken) return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();

  try {
    const response = await fetchImpl("https://api.github.com/user/emails", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": userAgent,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn("[github-email-fetch] request failed", {
        status: response.status,
        elapsedMs: Math.round(performance.now() - startedAt),
        // A 403 here almost always means the GitHub App is missing the "Email
        // addresses" account permission (read-only), so /user/emails is forbidden
        // even with a valid token. Without it, ALLOWED_EMAILS /
        // ALLOWED_EMAIL_DOMAINS can never match a GitHub sign-in, which otherwise
        // looks like an unexplained "no_matching_policy" denial. Surface a fix.
        // (OAuth App deployments authorize this via the user:email scope instead.)
        ...(response.status === 403 && {
          hint: "GitHub App is likely missing the 'Email addresses: Read-only' account permission; grant it and re-approve the installation, or ALLOWED_EMAILS/ALLOWED_EMAIL_DOMAINS will not match GitHub sign-ins.",
        }),
      });
      return [];
    }
    const result = githubEmailListSchema.safeParse(await response.json());
    if (!result.success) {
      console.warn("[github-email-fetch] invalid response", {
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      return [];
    }
    return result.data.filter((e) => e.verified);
  } catch (error) {
    console.warn("[github-email-fetch] request error", {
      error: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : String(error),
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

// Extend NextAuth types to include provider-agnostic identity plus the
// GitHub-only SCM fields.
declare module "next-auth" {
  interface Session {
    user: {
      id?: string; // Canonical provider user id: GitHub numeric id or Google sub
      login?: string; // GitHub username (GitHub-only)
      provider?: AuthProvider; // Which provider authenticated this session
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    accessToken?: string;
    refreshToken?: string;
    accessTokenExpiresAt?: number; // Unix timestamp in milliseconds
    githubUserId?: string;
    githubLogin?: string;
    provider?: AuthProvider;
    providerUserId?: string; // GitHub numeric id or Google sub
    // CP-issued web session tokens: minted by the provider-verified
    // exchange at sign-in, renewed via the rotating refresh grant through
    // the /api/auth/oi-refresh route (the jwt callback never renews).
    oiAccessToken?: string;
    oiAccessTokenExpiresAt?: number; // Unix timestamp in milliseconds
    oiRefreshToken?: string;
  }
}

export const BASE_GITHUB_OAUTH_SCOPE = "read:user user:email repo";

export function buildGitHubOAuthScope(
  allowedOrganizations = parseAllowlist(process.env.ALLOWED_GITHUB_ORGS)
): string {
  return allowedOrganizations.length > 0
    ? `${BASE_GITHUB_OAUTH_SCOPE} read:org`
    : BASE_GITHUB_OAUTH_SCOPE;
}

/**
 * Normalize Google's `email_verified` claim. Google has returned it as boolean
 * `true` or the string "true" (case-insensitive) depending on the flow; anything
 * else is treated as unverified and fails closed.
 */
function isVerifiedGoogleEmail(profile: Profile | undefined): boolean {
  const googleProfile = profile as { email_verified?: boolean | string } | undefined;
  return (
    googleProfile?.email_verified === true ||
    String(googleProfile?.email_verified).toLowerCase() === "true"
  );
}

/**
 * Resolve the static (synchronous) allow reason for a sign-in attempt, or null
 * when the static allowlists don't admit it. Pure and exported so the policy is
 * unit-testable — NextAuth's inline signIn callback otherwise can't be reached.
 *
 * Providers are handled explicitly; an unrecognized provider is denied
 * (default-closed) rather than treated as GitHub.
 *
 * - GitHub: the email was already resolved to the verified primary in the
 *   provider's userinfo override, so only the allowlist gate applies.
 * - Google: the email MUST be verified (see isVerifiedGoogleEmail) before any
 *   allowlist match. All email-based admission (the email allowlist here, and
 *   cross-provider account linking downstream) trusts this, so it is the single
 *   most security-sensitive check in the sign-in path.
 *
 * GitHub organization membership is intentionally NOT resolved here: it needs an
 * async call to GitHub's API, so the signIn callback applies it as a fallback
 * when this returns null.
 */
export function getStaticSignInReason(args: {
  provider: string | undefined;
  profile: Profile | undefined;
  emails: string[] | undefined;
  config: AccessControlConfig;
}): AccessAllowReason | null {
  const { provider, profile, emails, config } = args;

  switch (provider) {
    case "google": {
      // The email must be verified before any email-based allowlist match.
      if (!isVerifiedGoogleEmail(profile)) {
        return null;
      }
      return getAccessAllowReason(config, { emails });
    }
    case "github":
    case undefined: {
      // GitHub, including legacy sessions minted before the provider field
      // existed (treated as GitHub, matching resolveAuthProvider). The email was
      // already resolved to the verified primary in the provider's userinfo
      // override, so only the allowlist gate applies.
      const githubProfile = profile as { login?: string } | undefined;
      return getAccessAllowReason(config, {
        githubUsername: githubProfile?.login,
        emails,
      });
    }
    default:
      // Any other provider is denied rather than treated as GitHub, so admitting
      // a new provider is a deliberate case here and never relies on an email
      // this app has not verified for that provider.
      return null;
  }
}

/**
 * Apply provider claims to the JWT. Pure and exported for testing.
 *
 * SCM credentials (accessToken/refreshToken/expiry) are captured ONLY for
 * GitHub. A Google `access_token` must never populate `token.accessToken`: both
 * the session-create and ws-token routes forward `token.accessToken` as
 * `scmToken`, after which the control plane would use a Google token against
 * GitHub's API and refresh it at GitHub's OAuth endpoint (credential leak).
 *
 * On a non-GitHub sign-in we also CLEAR any GitHub SCM/identity claims carried
 * over from a prior GitHub session on the same JWT (NextAuth passes the previous
 * token into this callback), so a Google token can never hold stale GitHub
 * credentials. Cross-provider GitHub attribution for a linked user is resolved
 * server-side from D1, not from these cookie claims.
 */
export function applyJwtClaims(
  token: JWT,
  account: Account | null | undefined,
  profile: Profile | undefined
): JWT {
  if (account) {
    // Validate the provider against the supported set instead of casting. Only a
    // validated provider contributes an identity: an unrecognized provider stores
    // no provider/providerUserId and falls to the claim-clearing branch below, so
    // it can't surface as a legacy GitHub session via resolveAuthProvider.
    const provider = isAuthProvider(account.provider) ? account.provider : undefined;
    token.provider = provider;
    token.providerUserId = provider ? account.providerAccountId : undefined;

    if (provider === "github") {
      token.accessToken = account.access_token;
      token.refreshToken = account.refresh_token;
      // expires_at is in seconds, convert to milliseconds (only set if provided)
      token.accessTokenExpiresAt = account.expires_at ? account.expires_at * 1000 : undefined;
    } else {
      // Non-GitHub sign-in: drop any GitHub SCM/identity claims left on a token
      // reused from a prior GitHub session, so a Google JWT carries no SCM state.
      token.accessToken = undefined;
      token.refreshToken = undefined;
      token.accessTokenExpiresAt = undefined;
      token.githubUserId = undefined;
      token.githubLogin = undefined;
    }
  }

  if (profile) {
    // GitHub profile carries id (numeric) and login (username); Google profiles
    // carry neither, so these stay unset for Google sessions.
    const githubProfile = profile as { id?: number; login?: string };
    if (githubProfile.id) {
      token.githubUserId = githubProfile.id.toString();
    }
    if (githubProfile.login) {
      token.githubLogin = githubProfile.login;
    }
  }

  // Back-compat for the staggered deploy: GitHub JWTs minted before
  // provider/providerUserId existed carry githubUserId but no provider. Backfill
  // from githubUserId so session.user.id/provider stay correct without forcing a
  // re-login. Never fires for Google (no githubUserId) or fresh logins
  // (providerUserId is already set from the account above).
  if (!token.providerUserId && token.githubUserId) {
    token.provider = "github";
    token.providerUserId = token.githubUserId;
  }

  return token;
}

/**
 * Map JWT claims onto the session user. Pure and exported for testing.
 */
export function applySessionUser(session: Session, token: JWT): Session {
  if (session.user) {
    // Canonical provider user id, falling back to githubUserId so legacy GitHub
    // JWTs (minted before providerUserId existed) keep a stable session.user.id
    // across the deploy.
    session.user.id = token.providerUserId ?? token.githubUserId;
    session.user.provider = token.provider;
    // login is GitHub-only; undefined for Google sessions.
    session.user.login = token.githubLogin;
  }
  return session;
}

function logSignInDecision(
  login: string | undefined,
  decision: "allow" | "deny",
  reason: string
): void {
  console.info("[auth] sign-in decision", {
    login: login ?? null,
    decision,
    reason,
  });
}

function getOrgMembershipDecisionReason(orgMembership: GitHubOrganizationAccessResult): string {
  if (orgMembership.allowed) {
    return "org_membership";
  }

  return orgMembership.reason === "unavailable"
    ? "org_membership_unavailable"
    : "org_membership_denied";
}

const providers: NextAuthOptions["providers"] = [
  GitHubProvider<GithubProfile>({
    clientId: process.env.GITHUB_CLIENT_ID!,
    clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    authorization: {
      params: {
        scope: buildGitHubOAuthScope(),
      },
    },
    userinfo: {
      url: "https://api.github.com/user",
      async request({ client, tokens }) {
        const verifiedEmails = await getVerifiedGitHubEmails({ accessToken: tokens.access_token! });
        const profile = normalizeGitHubUserInfoProfile(
          await client.userinfo(tokens.access_token!),
          verifiedEmails
        );
        if (!profile) {
          throw new Error("Invalid GitHub userinfo response");
        }
        // SAFETY: NextAuth's Profile type is narrower than GitHub's numeric `id`,
        // but this object has just been validated against the GitHub userinfo shape.
        return profile as Profile;
      },
    },
  }),
];

// Google is opt-in: enabled only when both credentials are configured, so
// GitHub-only deployments are byte-unchanged. Scopes stay within the
// non-sensitive openid/email/profile set (no SCM access, no Google review).
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (googleClientId && googleClientSecret) {
  providers.push(
    GoogleProvider({
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      authorization: {
        params: {
          scope: "openid email profile",
        },
      },
    })
  );
}

export const authOptions: NextAuthOptions = {
  debug: process.env.NODE_ENV === "development" || process.env.NEXTAUTH_DEBUG === "true",
  providers,
  callbacks: {
    async signIn({ account, profile, user }) {
      const config: AccessControlConfig = {
        allowedDomains: parseAllowlist(process.env.ALLOWED_EMAIL_DOMAINS),
        allowedUsers: parseAllowlist(process.env.ALLOWED_USERS),
        allowedEmails: parseAllowlist(process.env.ALLOWED_EMAILS),
        allowedOrganizations: parseAllowlist(process.env.ALLOWED_GITHUB_ORGS),
        unsafeAllowAllUsers: parseBooleanEnv(process.env.UNSAFE_ALLOW_ALL_USERS),
      };

      const provider = account?.provider;
      const githubProfile = profile as { login?: string } | undefined;
      const isGitHubProvider = provider === "github" || provider === undefined;
      const hasAllowLists = config.allowedDomains.length > 0 || config.allowedEmails.length > 0;

      let emails: string[] | undefined = undefined;
      if (isGitHubProvider && hasAllowLists) {
        const verifiedEmails = (profile as ProfileWithVerifiedEmails | undefined)?.verifiedEmails;
        emails = verifiedEmails?.map((e) => e.email);
      } else {
        emails = user.email ? [user.email] : undefined;
      }

      // Static, synchronous allowlist gate. Provider-aware: Google requires a
      // verified email before any email-based match (see getStaticSignInReason).
      const staticReason = getStaticSignInReason({
        provider,
        profile,
        emails,
        config,
      });
      if (staticReason) {
        logSignInDecision(githubProfile?.login, "allow", staticReason);
        return true;
      }

      // GitHub organization membership fallback. Org membership is a GitHub
      // concept and the async check calls GitHub's API with the OAuth token, so
      // it runs only for GitHub sign-ins (including legacy sessions with no
      // provider) when at least one org is configured. Any other provider —
      // Google or unrecognized — fails closed here without contacting GitHub, so
      // a non-GitHub OAuth token is never sent to GitHub's API.
      const allowedOrganizations = config.allowedOrganizations ?? [];
      if (!isGitHubProvider || allowedOrganizations.length === 0) {
        logSignInDecision(githubProfile?.login, "deny", "no_matching_policy");
        return false;
      }

      const orgMembership = await checkGitHubOrganizationAccess({
        accessToken: account?.access_token,
        allowedOrganizations,
        userAgent: process.env.NEXT_PUBLIC_APP_NAME?.trim() || DEFAULT_APP_NAME,
      });

      logSignInDecision(
        githubProfile?.login,
        orgMembership.allowed ? "allow" : "deny",
        getOrgMembershipDecisionReason(orgMembership)
      );

      return orgMembership.allowed;
    },
    async jwt({ token, account, profile }) {
      return applyOiSessionTokens(applyJwtClaims(token, account, profile), account);
    },
    async session({ session, token }) {
      return applySessionUser(session, token);
    },
  },
  pages: {
    error: "/access-denied",
  },
};
