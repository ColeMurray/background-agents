import { BROWSER_AUTH_CLIENT_IP_HEADER } from "@open-inspect/shared/browser-auth-routes";
import { betterAuth } from "better-auth";
import { generateId } from "../crypto";
import type { AccountIdentityProjection } from "./account-identity-projection";
import type { CanonicalUserProjection } from "./canonical-user-projection";
import type { ProviderProfileResolver } from "./provider-profile";

const MS_PER_SECOND = 1000;

export const SESSION_EXPIRES_IN_MS = 7 * 24 * 60 * 60 * MS_PER_SECOND;
export const SESSION_UPDATE_AGE_MS = 24 * 60 * 60 * MS_PER_SECOND;

export interface SocialProviderAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly getUserInfo: ProviderProfileResolver;
}

export interface UserAuthConfig {
  readonly database: D1Database;
  readonly publicWebOrigin: string;
  readonly secret: string;
  readonly userProjection: CanonicalUserProjection;
  readonly identityProjection: AccountIdentityProjection;
  readonly github?: SocialProviderAuthConfig;
  readonly google?: SocialProviderAuthConfig;
}

/**
 * Creates the control plane's user-authentication authority.
 *
 * `publicWebOrigin` is deliberately the browser-visible web origin rather than
 * the control-plane origin. The web transparently proxies this handler, so all
 * redirects and host-only cookies remain scoped to the web application.
 */
export function createUserAuth(config: UserAuthConfig) {
  return betterAuth({
    baseURL: config.publicWebOrigin,
    database: config.database,
    secret: config.secret,
    trustedOrigins: [config.publicWebOrigin],
    telemetry: { enabled: false },
    // Workers do not expose NODE_ENV through process.env under every supported
    // compatibility date. Keep the production security behavior explicit.
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      storage: "memory",
    },
    advanced: {
      cookiePrefix: "openinspect",
      ipAddress: {
        ipAddressHeaders: [BROWSER_AUTH_CLIENT_IP_HEADER],
      },
      // Production is HTTPS-only. Loopback HTTP remains available for local
      // development, where browsers reject Secure cookies by design.
      useSecureCookies: new URL(config.publicWebOrigin).protocol === "https:",
      // Application authorization names users by the existing canonical
      // 32-character lowercase-hex ID. Keep Better Auth authoritative for ID
      // creation while preserving that stable cross-service contract.
      database: {
        generateId: () => generateId(),
      },
    },
    socialProviders: {
      ...(config.github
        ? {
            github: {
              ...config.github,
              disableDefaultScope: true,
            },
          }
        : {}),
      ...(config.google
        ? {
            google: {
              ...config.google,
              disableIdTokenSignIn: true,
            },
          }
        : {}),
    },
    user: {
      modelName: "auth_users",
    },
    session: {
      modelName: "auth_sessions",
      expiresIn: SESSION_EXPIRES_IN_MS / MS_PER_SECOND,
      updateAge: SESSION_UPDATE_AGE_MS / MS_PER_SECOND,
    },
    account: {
      modelName: "auth_accounts",
      // Implicit linking is deliberately enabled (the Better Auth default):
      // bot ingress links identities across providers by verified email on
      // every request, and pre-cutover web sign-in did the same — refusing it
      // at the web door locked out every canonical user without a seeded
      // auth account (#1290). requireLocalEmailVerified stays at its default
      // (true), making deliberate emailVerified seeding the linking gate.
      encryptOAuthTokens: true,
    },
    verification: {
      modelName: "auth_verifications",
      storeIdentifier: "hashed",
    },
    databaseHooks: {
      user: {
        create: {
          after: (user) => config.userProjection.project(user),
        },
        update: {
          after: (user) => config.userProjection.project(user),
        },
      },
      account: {
        // Both hooks project the account's subject into user_identities. The
        // create hook covers register and implicit-link flows; the update
        // hook fires on effectively every repeat sign-in (token refresh runs
        // through updateAccount), making it the retry chokepoint for a
        // projection missed at create time.
        create: {
          after: (account) => config.identityProjection.project(account),
        },
        update: {
          after: (account) => config.identityProjection.project(account),
        },
      },
    },
  });
}
