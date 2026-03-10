import type { NextRequest } from "next/server";
import type { NextAuthOptions } from "next-auth";
import type { JWT } from "next-auth/jwt";
import { getToken } from "next-auth/jwt";
import type { OAuthConfig } from "next-auth/providers/oauth";
import GitHubProvider from "next-auth/providers/github";
import { checkAccessAllowed, parseAllowlist } from "./access-control";
import { getServerScmProvider } from "./scm-provider";

// Extend NextAuth types to include provider-mapped SCM user info
declare module "next-auth" {
  interface Session {
    user: {
      id?: string; // Provider user ID
      login?: string; // Provider login / username
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
    providerUserId?: string;
    providerLogin?: string;
  }
}

interface ScmProfile {
  id?: number | string;
  login?: string;
  username?: string;
  nickname?: string;
  account_id?: string;
  uuid?: string;
  display_name?: string;
}

interface BitbucketProfile extends ScmProfile {
  email?: string;
  links?: {
    avatar?: {
      href?: string;
    };
  };
}

interface BitbucketEmailResponse {
  values?: Array<{
    email: string;
    is_primary: boolean;
    is_confirmed: boolean;
  }>;
}

interface BitbucketTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

const BITBUCKET_TOKEN_URL = "https://bitbucket.org/site/oauth2/access_token";
const BITBUCKET_REFRESH_BUFFER_MS = 60_000;
const DEFAULT_BITBUCKET_TOKEN_LIFETIME_MS = 2 * 60 * 60 * 1000;

function resolveProfileUserId(profile: ScmProfile): string | undefined {
  const candidate = profile.account_id ?? profile.uuid ?? profile.id;
  if (candidate == null) return undefined;
  return String(candidate);
}

function resolveProfileLogin(profile: ScmProfile): string | undefined {
  return profile.login ?? profile.username ?? profile.nickname ?? profile.display_name;
}

async function fetchBitbucketProfile(accessToken: string): Promise<BitbucketProfile> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };

  const userResponse = await fetch("https://api.bitbucket.org/2.0/user", {
    headers,
  });

  if (!userResponse.ok) {
    throw new Error(`Bitbucket userinfo error: ${userResponse.status}`);
  }

  const profile = (await userResponse.json()) as BitbucketProfile;

  const emailsResponse = await fetch("https://api.bitbucket.org/2.0/user/emails", {
    headers,
  });

  if (!emailsResponse.ok) {
    return profile;
  }

  const emails = (await emailsResponse.json()) as BitbucketEmailResponse;
  const primaryEmail =
    emails.values?.find((email) => email.is_primary && email.is_confirmed)?.email ??
    emails.values?.find((email) => email.is_confirmed)?.email ??
    null;

  return {
    ...profile,
    ...(primaryEmail ? { email: primaryEmail } : {}),
  };
}

export function createBitbucketProvider(): OAuthConfig<ScmProfile> {
  return {
    id: "bitbucket",
    name: "Bitbucket",
    type: "oauth",
    authorization: {
      url: "https://bitbucket.org/site/oauth2/authorize",
      params: {
        scope: "account email repository pullrequest offline_access",
      },
    },
    token: "https://bitbucket.org/site/oauth2/access_token",
    userinfo: {
      async request({ tokens }) {
        if (!tokens.access_token) {
          throw new Error("Bitbucket OAuth callback missing access token");
        }

        return fetchBitbucketProfile(tokens.access_token);
      },
    },
    clientId: process.env.BITBUCKET_CLIENT_ID!,
    clientSecret: process.env.BITBUCKET_CLIENT_SECRET!,
    profile(profile) {
      const bitbucketProfile = profile as BitbucketProfile;
      return {
        id: resolveProfileUserId(bitbucketProfile) ?? "",
        name: bitbucketProfile.display_name ?? resolveProfileLogin(bitbucketProfile) ?? null,
        email: bitbucketProfile.email ?? null,
        image: bitbucketProfile.links?.avatar?.href ?? null,
      };
    },
  };
}

function createProviders(): NextAuthOptions["providers"] {
  if (getServerScmProvider() === "bitbucket") {
    return [createBitbucketProvider()];
  }

  return [
    GitHubProvider({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      authorization: {
        params: {
          scope: "read:user user:email repo",
        },
      },
    }),
  ];
}

function getAccessControlConfig() {
  return {
    allowedDomains: parseAllowlist(process.env.ALLOWED_EMAIL_DOMAINS),
    allowedUsers: parseAllowlist(process.env.ALLOWED_USERS),
  };
}

function shouldRefreshBitbucketToken(token: JWT): boolean {
  return Boolean(
    token.refreshToken &&
      token.accessTokenExpiresAt &&
      token.accessTokenExpiresAt <= Date.now() + BITBUCKET_REFRESH_BUFFER_MS
  );
}

async function getRefreshableScmJwtToken(token: JWT): Promise<JWT> {
  if (getServerScmProvider() !== "bitbucket" || !shouldRefreshBitbucketToken(token)) {
    return token;
  }

  try {
    return await refreshBitbucketJwtToken(token);
  } catch (error) {
    console.error("Failed to refresh Bitbucket access token", error);
    return {
      ...token,
      accessToken: undefined,
      // Back off before retrying a failed refresh instead of immediately re-hitting Bitbucket.
      accessTokenExpiresAt: Date.now() + DEFAULT_BITBUCKET_TOKEN_LIFETIME_MS,
    };
  }
}

async function refreshBitbucketJwtToken(token: JWT): Promise<JWT> {
  if (!token.refreshToken) {
    return token;
  }

  if (!process.env.BITBUCKET_CLIENT_ID || !process.env.BITBUCKET_CLIENT_SECRET) {
    return token;
  }

  const response = await fetch(BITBUCKET_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(
        `${process.env.BITBUCKET_CLIENT_ID}:${process.env.BITBUCKET_CLIENT_SECRET}`
      ).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
    }),
  });

  const refreshed = (await response.json()) as BitbucketTokenResponse;
  if (!response.ok || refreshed.error || !refreshed.access_token) {
    throw new Error(
      refreshed.error_description ??
        refreshed.error ??
        `Bitbucket token refresh failed with status ${response.status}`
    );
  }

  return {
    ...token,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? token.refreshToken,
    accessTokenExpiresAt:
      Date.now() +
      (refreshed.expires_in
        ? refreshed.expires_in * 1000
        : DEFAULT_BITBUCKET_TOKEN_LIFETIME_MS),
  };
}

export async function getRequestScmTokenState(request: NextRequest): Promise<{
  accessToken?: string;
  accessTokenExpiresAt?: number;
  refreshToken?: string;
}> {
  const token = await getToken({ req: request });
  if (!token) {
    return {};
  }

  const resolvedToken = await getRefreshableScmJwtToken(token);
  return {
    accessToken:
      typeof resolvedToken.accessToken === "string" ? resolvedToken.accessToken : undefined,
    accessTokenExpiresAt:
      typeof resolvedToken.accessTokenExpiresAt === "number"
        ? resolvedToken.accessTokenExpiresAt
        : undefined,
    refreshToken:
      typeof resolvedToken.refreshToken === "string" ? resolvedToken.refreshToken : undefined,
  };
}

export const authOptions: NextAuthOptions = {
  debug: process.env.NODE_ENV === "development" || process.env.NEXTAUTH_DEBUG === "true",
  providers: createProviders(),
  callbacks: {
    async signIn({ profile, user }) {
      return checkAccessAllowed(getAccessControlConfig(), {
        scmUsername: resolveProfileLogin((profile ?? {}) as ScmProfile),
        email: user.email ?? undefined,
      });
    },
    async jwt({ token, account, profile }) {
      if (account) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token as string | undefined;
        // expires_at is in seconds, convert to milliseconds (only set if provided)
        token.accessTokenExpiresAt = account.expires_at ? account.expires_at * 1000 : undefined;
      }
      if (profile) {
        const providerProfile = profile as ScmProfile;
        token.providerUserId = resolveProfileUserId(providerProfile);
        token.providerLogin = resolveProfileLogin(providerProfile);
      }

      return getRefreshableScmJwtToken(token);
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.providerUserId;
        session.user.login = token.providerLogin;
      }
      return session;
    },
  },
  pages: {
    error: "/access-denied",
  },
};
