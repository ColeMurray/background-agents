import type { NextAuthOptions } from "next-auth";
import type { Provider } from "next-auth/providers/index";
import GitHubProvider from "next-auth/providers/github";
import GoogleProvider from "next-auth/providers/google";
import { checkAccessAllowed, parseAllowlist } from "./access-control";

/**
 * Auth provider selection.
 * Set AUTH_PROVIDER=google to use Google OAuth, otherwise GitHub is used.
 */
const AUTH_PROVIDER = process.env.AUTH_PROVIDER || "github";

// Extend NextAuth types to include provider-specific user info
declare module "next-auth" {
  interface Session {
    user: {
      id?: string;
      login?: string; // GitHub username (undefined for Google)
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
    userId?: string;
    userLogin?: string;
  }
}

function buildProvider(): Provider {
  if (AUTH_PROVIDER === "google") {
    const workspaceDomain = process.env.GOOGLE_WORKSPACE_DOMAIN;
    return GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      authorization: {
        params: {
          // Restrict to a Google Workspace domain if configured
          ...(workspaceDomain && { hd: workspaceDomain }),
          prompt: "consent",
          access_type: "offline",
          response_type: "code",
        },
      },
    });
  }

  return GitHubProvider({
    clientId: process.env.GITHUB_CLIENT_ID!,
    clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    authorization: {
      params: {
        scope: "read:user user:email repo",
      },
    },
  });
}

export const authOptions: NextAuthOptions = {
  debug: process.env.NODE_ENV === "development" || process.env.NEXTAUTH_DEBUG === "true",
  providers: [buildProvider()],
  callbacks: {
    async signIn({ profile, user }) {
      // Google Workspace domain check (server-side enforcement)
      if (AUTH_PROVIDER === "google") {
        const workspaceDomain = process.env.GOOGLE_WORKSPACE_DOMAIN;
        if (workspaceDomain && user.email) {
          const emailDomain = user.email.split("@")[1];
          if (emailDomain !== workspaceDomain) {
            return false;
          }
        }
      }

      // Access control (applies to both providers)
      const config = {
        allowedDomains: parseAllowlist(process.env.ALLOWED_EMAIL_DOMAINS),
        allowedUsers: parseAllowlist(process.env.ALLOWED_USERS),
      };

      const githubProfile = profile as { login?: string };
      return checkAccessAllowed(config, {
        githubUsername: AUTH_PROVIDER === "github" ? githubProfile.login : undefined,
        email: user.email ?? undefined,
      });
    },
    async jwt({ token, account, profile }) {
      if (account) {
        // Only store OAuth tokens for GitHub — they are used as SCM credentials
        // for PR creation. Google tokens are not SCM tokens and should not be
        // passed downstream as scmToken.
        if (AUTH_PROVIDER === "github") {
          token.accessToken = account.access_token;
          token.refreshToken = account.refresh_token as string | undefined;
          token.accessTokenExpiresAt = account.expires_at ? account.expires_at * 1000 : undefined;
        }
      }
      if (profile) {
        if (AUTH_PROVIDER === "google") {
          const googleProfile = profile as { sub?: string };
          if (googleProfile.sub) {
            token.userId = googleProfile.sub;
          }
        } else {
          const githubProfile = profile as { id?: number; login?: string };
          if (githubProfile.id) {
            token.userId = githubProfile.id.toString();
          }
          if (githubProfile.login) {
            token.userLogin = githubProfile.login;
          }
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.userId;
        session.user.login = token.userLogin;
      }
      return session;
    },
  },
  pages: {
    error: "/access-denied",
  },
};
