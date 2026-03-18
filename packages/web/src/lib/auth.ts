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
  }
}

export const authOptions: NextAuthOptions = {
  debug: process.env.NODE_ENV === "development" || process.env.NEXTAUTH_DEBUG === "true",
  providers: [
    (() => {
      const ghHostname = process.env.GITHUB_HOSTNAME;
      const isGHES = ghHostname && ghHostname !== "github.com";
      // Browser-side: user's browser redirects here (must be reachable by user)
      const browserBase = isGHES ? `https://${ghHostname}` : "https://github.com";
      // Server-side: Worker calls these for token exchange & API (must be reachable from edge)
      // GHES is in a private VPC, so route through Cloudflare Tunnel
      const ghesProxyUrl = process.env.GHES_TUNNEL_URL;
      const serverWebBase = isGHES && ghesProxyUrl ? ghesProxyUrl : browserBase;
      const serverApiBase =
        isGHES && ghesProxyUrl
          ? `${ghesProxyUrl}/api/v3`
          : isGHES
            ? `https://${ghHostname}/api/v3`
            : "https://api.github.com";

      return GitHubProvider({
        clientId: process.env.GITHUB_CLIENT_ID!,
        clientSecret: process.env.GITHUB_CLIENT_SECRET!,
        authorization: {
          url: `${browserBase}/login/oauth/authorize`,
          params: { scope: "read:user user:email repo" },
        },
        token: {
          url: `${serverWebBase}/login/oauth/access_token`,
          async request(context: any) {
            const { params, provider } = context;
            const res = await fetch(provider.token.url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
              },
              body: JSON.stringify({
                client_id: provider.clientId,
                client_secret: provider.clientSecret,
                code: params.code,
                redirect_uri: params.redirect_uri,
              }),
            });
            if (!res.ok) {
              const text = await res.text();
              throw new Error(`Token exchange failed: ${res.status} ${text}`);
            }
            const tokens = await res.json();
            return { tokens };
          },
        },
        userinfo: {
          url: `${serverApiBase}/user`,
          async request(context: any) {
            const { tokens } = context;
            const res = await fetch(`${serverApiBase}/user`, {
              headers: { Authorization: `token ${tokens.access_token}` },
            });
            if (!res.ok) throw new Error(`GitHub user fetch failed: ${res.status}`);
            const profile: Record<string, unknown> = await res.json();
            if (!profile.email) {
              const emailsRes = await fetch(`${serverApiBase}/user/emails`, {
                headers: { Authorization: `token ${tokens.access_token}` },
              });
              if (emailsRes.ok) {
                const emails: { email: string; primary: boolean }[] = await emailsRes.json();
                const picked = emails.find((e) => e.primary) ?? emails[0];
                if (picked) profile.email = picked.email;
              }
            }
            return profile;
          },
        },
      });
    })(),
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
