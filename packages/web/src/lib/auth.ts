import type { NextAuthOptions } from "next-auth";
import type { OAuthConfig } from "next-auth/providers/oauth";
import GitHubProvider from "next-auth/providers/github";
import { checkAccessAllowed, parseAllowlist } from "./access-control";

// Bitbucket profile type
interface BitbucketProfile {
  uuid: string;
  username: string;
  display_name: string;
  links: {
    avatar: {
      href: string;
    };
  };
  // Email comes from a separate endpoint
}

// Custom Bitbucket OAuth provider (not included in next-auth v4)
function BitbucketProvider(options: {
  clientId: string;
  clientSecret: string;
  authorization?: { params?: { scope?: string } };
}): OAuthConfig<BitbucketProfile> {
  return {
    id: "bitbucket",
    name: "Bitbucket",
    type: "oauth",
    authorization: {
      url: "https://bitbucket.org/site/oauth2/authorize",
      params: {
        response_type: "code",
        ...options.authorization?.params,
      },
    },
    token: {
      url: "https://bitbucket.org/site/oauth2/access_token",
      // Bitbucket requires Content-Type: application/x-www-form-urlencoded
      // This is handled by NextAuth, but we need to ensure proper grant_type
    },
    // Bitbucket requires HTTP Basic auth for token endpoint (client_secret_basic)
    client: {
      token_endpoint_auth_method: "client_secret_basic",
    },
    userinfo: {
      url: "https://api.bitbucket.org/2.0/user",
      async request({ tokens }) {
        const profile = await fetch("https://api.bitbucket.org/2.0/user", {
          headers: {
            Authorization: `Bearer ${tokens.access_token}`,
          },
        }).then((res) => res.json());

        // Fetch email separately
        const emails = await fetch(
          "https://api.bitbucket.org/2.0/user/emails",
          {
            headers: {
              Authorization: `Bearer ${tokens.access_token}`,
            },
          }
        ).then((res) => res.json());

        // Find primary email
        const primaryEmail = emails.values?.find(
          (e: { is_primary: boolean; email: string }) => e.is_primary
        )?.email;

        return {
          ...profile,
          email: primaryEmail,
        };
      },
    },
    profile(profile) {
      return {
        id: profile.uuid,
        name: profile.display_name,
        email: (profile as BitbucketProfile & { email?: string }).email ?? null,
        image: profile.links?.avatar?.href,
      };
    },
    clientId: options.clientId,
    clientSecret: options.clientSecret,
  };
}

// VCS Provider type
export type VCSProvider = "github" | "bitbucket";

// Extend NextAuth types to include provider-specific user info
declare module "next-auth" {
  interface Session {
    accessToken?: string;
    accessTokenExpiresAt?: number; // Unix timestamp in milliseconds
    provider?: VCSProvider;
    user: {
      id?: string; // Provider user ID
      login?: string; // Provider username
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
    provider?: VCSProvider;
    githubUserId?: string;
    githubLogin?: string;
    bitbucketUuid?: string;
    bitbucketLogin?: string;
    bitbucketDisplayName?: string;
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
    BitbucketProvider({
      clientId: process.env.BITBUCKET_CLIENT_ID!,
      clientSecret: process.env.BITBUCKET_CLIENT_SECRET!,
      authorization: {
        params: {
          scope: "repository:write account email",
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

      if (account?.provider === "github") {
        const githubProfile = profile as { login?: string };
        const isAllowed = checkAccessAllowed(config, {
          githubUsername: githubProfile.login,
          email: user.email ?? undefined,
        });
        return isAllowed;
      }

      if (account?.provider === "bitbucket") {
        const bitbucketProfile = profile as { username?: string; display_name?: string };
        const isAllowed = checkAccessAllowed(config, {
          githubUsername: bitbucketProfile.username,
          email: user.email ?? undefined,
        });
        return isAllowed;
      }

      return false;
    },
    async jwt({ token, account, profile }) {
      if (account) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token as string | undefined;

        if (account.provider === "github") {
          token.provider = "github";
          if (account.expires_at) {
            token.accessTokenExpiresAt = account.expires_at * 1000;
          } else {
            token.accessTokenExpiresAt = undefined;
          }
        } else if (account.provider === "bitbucket") {
          token.provider = "bitbucket";
          if (account.expires_at) {
            token.accessTokenExpiresAt = account.expires_at * 1000;
          } else {
            token.accessTokenExpiresAt = Date.now() + 60 * 60 * 1000;
          }
        }
      }

      if (profile) {
        if (token.provider === "github") {
          const githubProfile = profile as { id?: number; login?: string };
          if (githubProfile.id) {
            token.githubUserId = githubProfile.id.toString();
          }
          if (githubProfile.login) {
            token.githubLogin = githubProfile.login;
          }
        } else if (token.provider === "bitbucket") {
          const bitbucketProfile = profile as {
            uuid?: string;
            username?: string;
            display_name?: string;
          };
          if (bitbucketProfile.uuid) {
            token.bitbucketUuid = bitbucketProfile.uuid;
          }
          if (bitbucketProfile.username) {
            token.bitbucketLogin = bitbucketProfile.username;
          }
          if (bitbucketProfile.display_name) {
            token.bitbucketDisplayName = bitbucketProfile.display_name;
          }
        }
      }
      return token;
    },
    async session({ session, token }) {
      session.accessToken = token.accessToken;
      session.accessTokenExpiresAt = token.accessTokenExpiresAt;
      session.provider = token.provider;

      if (session.user) {
        if (token.provider === "github") {
          session.user.id = token.githubUserId;
          session.user.login = token.githubLogin;
        } else if (token.provider === "bitbucket") {
          session.user.id = token.bitbucketUuid;
          session.user.login = token.bitbucketLogin;
          if (token.bitbucketDisplayName) {
            session.user.name = token.bitbucketDisplayName;
          }
        }
      }
      return session;
    },
  },
  pages: {
    error: "/access-denied",
  },
};
