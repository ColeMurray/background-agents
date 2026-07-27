import { betterAuth } from "better-auth";
import { generateId } from "./crypto";

const MS_PER_SECOND = 1000;

export const BROWSER_AUTH_SESSION_EXPIRES_IN_MS = 7 * 24 * 60 * 60 * MS_PER_SECOND;
export const BROWSER_AUTH_SESSION_UPDATE_AGE_MS = 24 * 60 * 60 * MS_PER_SECOND;

export interface BrowserAuthConfig {
  readonly database: D1Database;
  readonly publicWebOrigin: string;
  readonly secret: string;
}

/**
 * Creates the control plane's browser-authentication authority.
 *
 * `publicWebOrigin` is deliberately the browser-visible web origin rather than
 * the control-plane origin. The web transparently proxies this handler, so all
 * redirects and host-only cookies remain scoped to the web application.
 */
export function createBrowserAuth(config: BrowserAuthConfig) {
  return betterAuth({
    baseURL: config.publicWebOrigin,
    database: config.database,
    secret: config.secret,
    trustedOrigins: [config.publicWebOrigin],
    telemetry: { enabled: false },
    advanced: {
      cookiePrefix: "openinspect",
      useSecureCookies: true,
      // Browser authentication and application authorization share the same
      // canonical user ID. The activation layer projects this ID into users.id
      // before any Better Auth route is exposed.
      database: {
        generateId: () => generateId(),
      },
    },
    user: {
      modelName: "auth_users",
    },
    session: {
      modelName: "auth_sessions",
      expiresIn: BROWSER_AUTH_SESSION_EXPIRES_IN_MS / MS_PER_SECOND,
      updateAge: BROWSER_AUTH_SESSION_UPDATE_AGE_MS / MS_PER_SECOND,
    },
    account: {
      modelName: "auth_accounts",
      accountLinking: {
        disableImplicitLinking: true,
      },
      encryptOAuthTokens: true,
    },
    verification: {
      modelName: "auth_verifications",
      storeIdentifier: "hashed",
    },
  });
}
