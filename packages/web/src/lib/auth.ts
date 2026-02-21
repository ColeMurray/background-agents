import type { NextAuthOptions } from "next-auth";
import GitHubProvider from "next-auth/providers/github";
import type { OAuthConfig } from "next-auth/providers/oauth";
import { checkAccessAllowed, parseAllowlist } from "./access-control";

interface BitbucketProfile {
  uuid?: string;
  username?: string;
  display_name?: string;
  account_id?: string;
  links?: {
    avatar?: {
      href?: string;
    };
  };
}

function BitbucketProvider(options: {
  clientId: string;
  clientSecret: string;
}): OAuthConfig<Record<string, unknown>> {
  return {
    id: "bitbucket",
    name: "Bitbucket",
    type: "oauth",
    authorization: {
      url: "https://bitbucket.org/site/oauth2/authorize",
      params: {
        // Keep sign-in scopes minimal; repo/PR API access is handled by control-plane tokens.
        scope: "account email",
      },
    },
    token: "https://bitbucket.org/site/oauth2/access_token",
    userinfo: {
      async request({ tokens }) {
        const token = tokens.access_token;
        if (!token) {
          throw new Error("Bitbucket OAuth callback missing access token");
        }

        const primary = await fetch("https://api.bitbucket.org/2.0/user", {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
        });
        if (primary.ok) {
          return (await primary.json()) as Record<string, unknown>;
        }

        throw new Error(`Bitbucket userinfo failed (${primary.status})`);
      },
    },
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    profile(profile) {
      const bitbucketProfile = profile as BitbucketProfile;
      return {
        id: bitbucketProfile.account_id ?? bitbucketProfile.uuid ?? "",
        name: bitbucketProfile.display_name ?? bitbucketProfile.username ?? "Bitbucket User",
        email: null,
        image: bitbucketProfile.links?.avatar?.href ?? null,
      };
    },
  };
}

declare module "next-auth" {
  interface Session {
    user: {
      id?: string;
      login?: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      vcsProvider?: "github" | "bitbucket";
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    vcsProvider?: "github" | "bitbucket";
    accessToken?: string;
    refreshToken?: string;
    accessTokenExpiresAt?: number;
    githubUserId?: string;
    githubLogin?: string;
    scmUserId?: string;
    scmLogin?: string;
  }
}

export const authOptions: NextAuthOptions = {
  debug: process.env.NODE_ENV === "development" || process.env.NEXTAUTH_DEBUG === "true",
  providers: [
    ...(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
      ? [
          GitHubProvider({
            clientId: process.env.GITHUB_CLIENT_ID,
            clientSecret: process.env.GITHUB_CLIENT_SECRET,
            authorization: {
              params: {
                scope: "read:user user:email repo",
              },
            },
          }),
        ]
      : []),
    ...(process.env.BITBUCKET_CLIENT_ID && process.env.BITBUCKET_CLIENT_SECRET
      ? [
          BitbucketProvider({
            clientId: process.env.BITBUCKET_CLIENT_ID,
            clientSecret: process.env.BITBUCKET_CLIENT_SECRET,
          }),
        ]
      : []),
  ],
  callbacks: {
    async signIn({ profile, user, account }) {
      const provider = account?.provider;
      const config = {
        allowedDomains: parseAllowlist(process.env.ALLOWED_EMAIL_DOMAINS),
        allowedUsers: parseAllowlist(process.env.ALLOWED_USERS),
      };

      const githubProfile = profile as { login?: string };
      const bitbucketProfile = profile as { username?: string };
      const username = provider === "bitbucket" ? bitbucketProfile.username : githubProfile.login;
      const isAllowed = checkAccessAllowed(config, {
        githubUsername: username,
        email: user.email ?? undefined,
      });

      return isAllowed;
    },
    async jwt({ token, account, profile }) {
      if (account) {
        token.vcsProvider = account.provider as "github" | "bitbucket";
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token as string | undefined;
        token.accessTokenExpiresAt = account.expires_at ? account.expires_at * 1000 : undefined;
      }

      if (profile) {
        if (token.vcsProvider === "bitbucket") {
          const bitbucketProfile = profile as {
            account_id?: string;
            uuid?: string;
            username?: string;
          };
          const scmUserId = bitbucketProfile.account_id ?? bitbucketProfile.uuid;
          if (scmUserId) {
            token.scmUserId = scmUserId;
          }
          if (bitbucketProfile.username) {
            token.scmLogin = bitbucketProfile.username;
          }
        } else {
          const githubProfile = profile as { id?: number; login?: string };
          if (githubProfile.id) {
            token.scmUserId = githubProfile.id.toString();
            token.githubUserId = githubProfile.id.toString();
          }
          if (githubProfile.login) {
            token.scmLogin = githubProfile.login;
            token.githubLogin = githubProfile.login;
          }
        }
      }

      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.scmUserId ?? token.githubUserId;
        session.user.login = token.scmLogin ?? token.githubLogin;
        session.user.vcsProvider = token.vcsProvider;
      }
      return session;
    },
  },
  pages: {
    error: "/access-denied",
  },
};
