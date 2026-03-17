import type { NextRequest } from "next/server";
import type { NextAuthOptions } from "next-auth";
import type { JWT } from "next-auth/jwt";
import GitHubProvider from "next-auth/providers/github";
import { getToken } from "next-auth/jwt";
import { checkAccessAllowed, parseAllowlist } from "./access-control";

// Extend NextAuth types to include GitHub-specific user info
declare module "next-auth" {
  interface Session {
    user: {
      id?: string; // GitHub user ID
      login?: string; // GitHub username
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
    error?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    accessToken?: string;
    refreshToken?: string;
    accessTokenExpiresAt?: number; // Unix timestamp in milliseconds
    githubUserId?: string;
    githubLogin?: string;
    error?: string;
  }
}

/** Refresh the access token 5 minutes before it expires. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface GitHubTokenRefreshResponse {
  access_token: string;
  token_type: string;
  scope: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface RefreshedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/**
 * In-flight refresh deduplication.
 * Prevents concurrent requests from consuming the same single-use refresh
 * token multiple times. Keyed by refresh token value so that a rotated token
 * starts a fresh entry.
 */
let inflightRefresh: { key: string; promise: Promise<RefreshedTokens> } | null = null;

async function refreshAccessToken(refreshToken: string): Promise<RefreshedTokens> {
  // Deduplicate: if a refresh for the same token is already in flight, join it
  if (inflightRefresh && inflightRefresh.key === refreshToken) {
    return inflightRefresh.promise;
  }

  const promise = doRefreshAccessToken(refreshToken);
  inflightRefresh = { key: refreshToken, promise };
  promise.finally(() => {
    if (inflightRefresh?.key === refreshToken) {
      inflightRefresh = null;
    }
  });
  return promise;
}

async function doRefreshAccessToken(refreshToken: string): Promise<RefreshedTokens> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID!,
      client_secret: process.env.GITHUB_CLIENT_SECRET!,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  const data = (await response.json()) as GitHubTokenRefreshResponse;

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : Date.now() + 8 * 3600 * 1000,
  };
}

function needsRefresh(token: JWT): boolean {
  return !!(
    token.accessTokenExpiresAt &&
    token.refreshToken &&
    Date.now() + REFRESH_BUFFER_MS >= token.accessTokenExpiresAt
  );
}

/**
 * Get the current user's JWT with fresh tokens.
 *
 * In NextAuth v4, `getToken()` decodes the incoming request cookie and does
 * NOT invoke `callbacks.jwt`. That means the jwt callback's token rotation
 * only updates the response cookie — the same request still sees stale
 * values. This helper applies the same refresh logic inline so route
 * handlers always get current tokens.
 */
export async function getAuthenticatedToken(req: NextRequest): Promise<JWT | null> {
  const token = await getToken({ req });
  if (!token) return null;

  if (needsRefresh(token)) {
    try {
      const refreshed = await refreshAccessToken(token.refreshToken!);
      return {
        ...token,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        accessTokenExpiresAt: refreshed.expiresAt,
        error: undefined,
      };
    } catch (error) {
      console.error("Failed to refresh access token:", error);
      return { ...token, error: "RefreshAccessTokenError" };
    }
  }

  return token;
}

export const authOptions: NextAuthOptions = {
  debug: process.env.NODE_ENV === "development" || process.env.NEXTAUTH_DEBUG === "true",
  providers: [
    GitHubProvider({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      authorization: {
        params: {
          scope: "read:user user:email repo",
        },
      },
    }),
  ],
  callbacks: {
    async signIn({ profile, user }) {
      const config = {
        allowedDomains: parseAllowlist(process.env.ALLOWED_EMAIL_DOMAINS),
        allowedUsers: parseAllowlist(process.env.ALLOWED_USERS),
      };

      const githubProfile = profile as { login?: string };
      const isAllowed = checkAccessAllowed(config, {
        githubUsername: githubProfile.login,
        email: user.email ?? undefined,
      });

      if (!isAllowed) {
        return false;
      }
      return true;
    },
    async jwt({ token, account, profile }) {
      // Initial sign-in — store tokens from OAuth response
      if (account) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token as string | undefined;
        token.accessTokenExpiresAt = account.expires_at ? account.expires_at * 1000 : undefined;
        token.error = undefined;
      }

      if (profile) {
        const githubProfile = profile as { id?: number; login?: string };
        if (githubProfile.id) {
          token.githubUserId = githubProfile.id.toString();
        }
        if (githubProfile.login) {
          token.githubLogin = githubProfile.login;
        }
      }

      // Token rotation — refresh if access token is expiring soon.
      // Updates the response cookie so subsequent requests get fresh tokens.
      if (needsRefresh(token)) {
        try {
          const refreshed = await refreshAccessToken(token.refreshToken!);
          token.accessToken = refreshed.accessToken;
          token.refreshToken = refreshed.refreshToken;
          token.accessTokenExpiresAt = refreshed.expiresAt;
          token.error = undefined;
        } catch (error) {
          console.error("Failed to refresh access token:", error);
          token.error = "RefreshAccessTokenError";
        }
      }

      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.githubUserId;
        session.user.login = token.githubLogin;
      }
      if (token.error) {
        session.error = token.error;
      }
      return session;
    },
  },
  pages: {
    error: "/access-denied",
  },
};
