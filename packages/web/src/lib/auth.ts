import type { NextAuthOptions } from "next-auth";
import GitHubProvider from "next-auth/providers/github";
import { DEFAULT_APP_NAME } from "@open-inspect/shared";
import {
  type AccessControlConfig,
  checkGitHubOrganizationAccess,
  getAccessAllowReason,
  parseAllowlist,
  parseBooleanEnv,
} from "./access-control";

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

function getAccessControlConfig(): AccessControlConfig {
  return {
    allowedDomains: parseAllowlist(process.env.ALLOWED_EMAIL_DOMAINS),
    allowedUsers: parseAllowlist(process.env.ALLOWED_USERS),
    allowedOrganizations: parseAllowlist(process.env.ALLOWED_GITHUB_ORGS),
    unsafeAllowAllUsers: parseBooleanEnv(process.env.UNSAFE_ALLOW_ALL_USERS),
  };
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

export const authOptions: NextAuthOptions = {
  debug: process.env.NODE_ENV === "development" || process.env.NEXTAUTH_DEBUG === "true",
  providers: [
    GitHubProvider({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      authorization: {
        params: {
          scope: buildGitHubOAuthScope(),
        },
      },
    }),
  ],
  callbacks: {
    async signIn({ account, profile, user }) {
      const config = getAccessControlConfig();
      const allowedOrganizations = config.allowedOrganizations ?? [];
      const githubProfile = profile as { login?: string };
      const staticAllowReason = getAccessAllowReason(config, {
        githubUsername: githubProfile.login,
        email: user.email ?? undefined,
      });

      if (staticAllowReason) {
        logSignInDecision(githubProfile.login, "allow", staticAllowReason);
        return true;
      }

      if (allowedOrganizations.length === 0) {
        logSignInDecision(githubProfile.login, "deny", "no_matching_policy");
        return false;
      }

      const isAllowedByOrgMembership = await checkGitHubOrganizationAccess({
        accessToken: account?.access_token,
        allowedOrganizations,
        userAgent: process.env.NEXT_PUBLIC_APP_NAME?.trim() || DEFAULT_APP_NAME,
      });

      logSignInDecision(
        githubProfile.login,
        isAllowedByOrgMembership ? "allow" : "deny",
        isAllowedByOrgMembership ? "org_membership" : "org_membership_denied"
      );

      return isAllowedByOrgMembership;
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
