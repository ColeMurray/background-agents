import type { NextAuthOptions } from "next-auth";
import GitHubProvider from "next-auth/providers/github";
import { checkAccessAllowed, parseAllowlist } from "./access-control";

// Extend NextAuth types to include GitHub-specific user info
declare module "next-auth" {
  interface Session {
    accessToken?: string;
    accessTokenExpiresAt?: number; // Unix timestamp in milliseconds
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
      if (account) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token as string | undefined;
        // expires_at is in seconds, convert to milliseconds (only set if provided)
        token.accessTokenExpiresAt = account.expires_at ? account.expires_at * 1000 : undefined;
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
      // Add GitHub-specific info to session
      session.accessToken = token.accessToken;
      session.accessTokenExpiresAt = token.accessTokenExpiresAt;
      if (session.user) {
        session.user.id = token.githubUserId;
        session.user.login = token.githubLogin;
      }
      return session;
    },
  },
  pages: {
    error: "/access-denied",
  },
};
