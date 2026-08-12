import { BROWSER_AUTH_CLIENT_IP_HEADER } from "@open-inspect/shared/browser-auth-routes";
import { betterAuth } from "better-auth";
import { createCanonicalBetterAuthAdapter } from "../../db/better-auth-adapter";
import type { SqlDatabase } from "../../db/sql-database";
import { generateId } from "../crypto";
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
  readonly database: SqlDatabase;
  readonly publicWebOrigin: string;
  readonly secret: string;
  readonly github?: SocialProviderAuthConfig;
  readonly google?: SocialProviderAuthConfig;
}

/**
 * Creates the control plane's user-authentication authority.
 *
 * Better Auth persists directly into the canonical identity registry (issue
 * #1290 consolidation): its user model IS `users` and its account model IS
 * `user_identities`, via the field maps below and the canonical SQL adapter.
 * With a single registry there is nothing to keep synchronized — a
 * bot-created GitHub identity is an account, so `findOAuthUser`'s
 * account-first lookup signs bot-first users into their canonical row
 * natively. Sessions and OAuth-state verifications stay in Better Auth-owned
 * tables (epoch-ms columns, same adapter).
 *
 * `publicWebOrigin` is deliberately the browser-visible web origin rather than
 * the control-plane origin. The web transparently proxies this handler, so all
 * redirects and host-only cookies remain scoped to the web application.
 */
export function createUserAuth(config: UserAuthConfig) {
  return betterAuth({
    baseURL: config.publicWebOrigin,
    database: createCanonicalBetterAuthAdapter(config.database),
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
      modelName: "users",
      fields: {
        name: "display_name",
        emailVerified: "email_verified",
        image: "avatar_url",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    session: {
      modelName: "auth_sessions",
      expiresIn: SESSION_EXPIRES_IN_MS / MS_PER_SECOND,
      updateAge: SESSION_UPDATE_AGE_MS / MS_PER_SECOND,
    },
    account: {
      modelName: "user_identities",
      fields: {
        accountId: "provider_user_id",
        providerId: "provider",
        userId: "user_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
      // Implicit linking is deliberately enabled (the Better Auth default):
      // bot ingress links identities across providers by verified email on
      // every request, and pre-cutover web sign-in did the same — refusing it
      // at the web door locked out every canonical user without a sign-in
      // identity (#1290). requireLocalEmailVerified stays at its default
      // (true): `users.email_verified` — written by completed OAuth proof,
      // attested bot ingress (EMAIL_ATTESTING_PROVIDERS in db/user-store.ts),
      // or the one-time 0057 backlog verify — is the linking gate.
      encryptOAuthTokens: true,
    },
    verification: {
      modelName: "auth_verifications",
      storeIdentifier: "hashed",
    },
  });
}
