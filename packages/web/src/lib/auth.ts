import type { NextAuthOptions } from "next-auth";
import GitHubProvider from "next-auth/providers/github";
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
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    accessToken?: string;
    refreshToken?: string;
    accessTokenExpiresAt?: number; // Unix timestamp in milliseconds
    githubUserId?: string;
    githubLogin?: string;
    githubEmail?: string; // Primary verified email for git commit attribution
  }
}

/**
 * Fetch the user's primary verified email from GitHub.
 * Requires the `user:email` OAuth scope.
 */
async function fetchGitHubPrimaryEmail(accessToken: string): Promise<string | null> {
  try {
    const response = await fetch("https://api.github.com/user/emails", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Open-Inspect",
      },
    });

    if (!response.ok) {
      console.warn(`[auth] Failed to fetch GitHub emails: ${response.status}`);
      return null;
    }

    const emails = (await response.json()) as Array<{
      email: string;
      primary: boolean;
      verified: boolean;
    }>;
    const primary = emails.find((e) => e.primary && e.verified);
    return primary?.email ?? null;
  } catch (error) {
    console.warn("[auth] Error fetching GitHub emails:", error);
    return null;
  }
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
    async signIn({ profile, user, account }) {
      const config = {
        allowedDomains: parseAllowlist(process.env.ALLOWED_EMAIL_DOMAINS),
        allowedUsers: parseAllowlist(process.env.ALLOWED_USERS),
      };

      const githubProfile = profile as { login?: string };

      // Resolve the real email even when the GitHub profile email is private.
      let email = user.email ?? undefined;
      if (!email && account?.access_token) {
        email = (await fetchGitHubPrimaryEmail(account.access_token)) ?? undefined;
      }

      const isAllowed = checkAccessAllowed(config, {
        githubUsername: githubProfile.login,
        email,
      });

      if (!isAllowed) {
        return false;
      }
      return true;
    },
    async jwt({ token, account, profile }) {
      if (account) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token as string | undefined;
        // expires_at is in seconds, convert to milliseconds (only set if provided)
        token.accessTokenExpiresAt = account.expires_at ? account.expires_at * 1000 : undefined;

        // Fetch primary verified email from GitHub for git commit attribution.
        // The profile.email field is null when the user's email is private,
        // but the /user/emails endpoint returns it with the user:email scope.
        if (account.access_token) {
          const email = await fetchGitHubPrimaryEmail(account.access_token);
          if (email) {
            token.githubEmail = email;
          }
        }
      }
      if (profile) {
        // GitHub profile includes id (numeric) and login (username)
        const githubProfile = profile as { id?: number; login?: string };
        if (githubProfile.id) {
          token.githubUserId = githubProfile.id.toString();
        }
        if (githubProfile.login) {
          token.githubLogin = githubProfile.login;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.githubUserId;
        session.user.login = token.githubLogin;
        // Prefer the email fetched from GitHub's /user/emails endpoint,
        // which works even when the user's profile email is private.
        if (token.githubEmail) {
          session.user.email = token.githubEmail;
        }
      }
      return session;
    },
  },
  pages: {
    error: "/access-denied",
  },
};
