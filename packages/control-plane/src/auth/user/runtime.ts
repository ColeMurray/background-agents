import {
  AdmissionPolicy,
  parseAdmissionAllowlist,
  parseAdmissionBoolean,
  type AdmissionPolicyConfig,
} from "./admission-policy";
import { SIGN_IN_PROVIDERS, type SignInProvider } from "@open-inspect/shared";
import { createUserAuth, type UserAuthConfig } from "./better-auth";
import { GitHubProviderIdentityResolver } from "./providers/github-identity";
import { GitHubSignInProfileResolver } from "./providers/github-profile";
import { GoogleSignInProfileResolver } from "./providers/google-profile";
import { D1CanonicalUserProjection } from "../../db/canonical-user-projection";
import type { Env } from "../../types";

const GITHUB_ISSUER = "https://github.com";
const MINIMUM_SECRET_LENGTH = 32;

export class UserAuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserAuthConfigurationError";
  }
}

function requireConfig(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new UserAuthConfigurationError(`${name} is not configured`);
  }
  return normalized;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function parsePublicWebOrigin(value: string | undefined): string {
  const configured = requireConfig(value, "WEB_APP_URL");
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new UserAuthConfigurationError("WEB_APP_URL is invalid");
  }

  const isOriginOnly =
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "";
  const isSecure = url.protocol === "https:";
  const isLocalDevelopment = url.protocol === "http:" && isLoopbackHost(url.hostname);
  if (!isOriginOnly || (!isSecure && !isLocalDevelopment)) {
    throw new UserAuthConfigurationError(
      "WEB_APP_URL must be an HTTPS origin or an HTTP loopback origin"
    );
  }
  return url.origin;
}

interface ProviderCredentials {
  readonly id: SignInProvider;
  readonly clientId: string;
  readonly clientSecret: string;
}

interface NormalizedUserAuthConfig {
  readonly publicWebOrigin: string;
  readonly secret: string;
  readonly appName: string;
  readonly admission: AdmissionPolicyConfig;
  readonly providers: readonly ProviderCredentials[];
}

function normalizeProviderCredentials(
  id: SignInProvider,
  clientIdValue: string | undefined,
  clientSecretValue: string | undefined
): ProviderCredentials | null {
  const clientId = clientIdValue?.trim();
  const clientSecret = clientSecretValue?.trim();
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    const prefix = id.toUpperCase();
    throw new UserAuthConfigurationError(
      `${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET must be configured together`
    );
  }
  return clientId && clientSecret ? { id, clientId, clientSecret } : null;
}

function normalizeUserAuthConfig(env: Env): NormalizedUserAuthConfig {
  const secret = requireConfig(env.BROWSER_AUTH_SECRET, "BROWSER_AUTH_SECRET");
  if (secret.length < MINIMUM_SECRET_LENGTH) {
    throw new UserAuthConfigurationError(
      `BROWSER_AUTH_SECRET must be at least ${MINIMUM_SECRET_LENGTH} characters`
    );
  }

  const credentials: Record<SignInProvider, ProviderCredentials | null> = {
    github: normalizeProviderCredentials("github", env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET),
    google: normalizeProviderCredentials("google", env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
  };
  const providers = SIGN_IN_PROVIDERS.flatMap((id) => {
    const provider = credentials[id];
    return provider ? [provider] : [];
  });
  if (providers.length === 0) {
    throw new UserAuthConfigurationError(
      "At least one sign-in provider must be configured: set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, or GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET"
    );
  }

  return {
    publicWebOrigin: parsePublicWebOrigin(env.WEB_APP_URL),
    secret,
    appName: env.APP_NAME?.trim() || "Open-Inspect",
    admission: {
      allowedGitHubUsers: parseAdmissionAllowlist(env.ALLOWED_USERS),
      allowedEmails: parseAdmissionAllowlist(env.ALLOWED_EMAILS),
      allowedEmailDomains: parseAdmissionAllowlist(env.ALLOWED_EMAIL_DOMAINS),
      allowedGitHubOrganizations: parseAdmissionAllowlist(env.ALLOWED_GITHUB_ORGS),
      unsafeAllowAllUsers: parseAdmissionBoolean(env.UNSAFE_ALLOW_ALL_USERS),
    },
    providers: Object.freeze(providers),
  };
}

function createUserAuthRuntime(
  config: NormalizedUserAuthConfig,
  database: D1Database
): UserAuthRuntime {
  const admissionPolicy = new AdmissionPolicy(config.admission);
  let github: UserAuthConfig["github"];
  let google: UserAuthConfig["google"];

  for (const provider of config.providers) {
    if (!admissionPolicy.supportsSignInProvider(provider.id)) {
      if (provider.id === "google") {
        throw new UserAuthConfigurationError(
          "Google sign-in requires provider-neutral admission through ALLOWED_EMAILS, ALLOWED_EMAIL_DOMAINS, or UNSAFE_ALLOW_ALL_USERS"
        );
      }
      throw new UserAuthConfigurationError(
        "GitHub sign-in has no compatible admission policy; configure a GitHub-specific or provider-neutral admission rule, or UNSAFE_ALLOW_ALL_USERS"
      );
    }

    if (provider.id === "github") {
      const profile = new GitHubSignInProfileResolver({
        identityResolver: new GitHubProviderIdentityResolver({
          issuer: GITHUB_ISSUER,
          userAgent: `${config.appName} Control Plane`,
        }),
        admissionPolicy,
      });
      github = {
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
        getUserInfo: profile.getUserInfo,
      };
    } else {
      const profile = new GoogleSignInProfileResolver({
        clientId: provider.clientId,
        admissionPolicy,
      });
      google = {
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
        getUserInfo: profile.getUserInfo,
      };
    }
  }

  const auth = createUserAuth({
    database,
    publicWebOrigin: config.publicWebOrigin,
    secret: config.secret,
    userProjection: new D1CanonicalUserProjection(database),
    ...(github ? { github } : {}),
    ...(google ? { google } : {}),
  });
  return {
    auth,
    enabledProviders: Object.freeze(config.providers.map((provider) => provider.id)),
  };
}

export function createUserAuthRuntimeFromEnv(env: Env, database: D1Database): UserAuthRuntime {
  return createUserAuthRuntime(normalizeUserAuthConfig(env), database);
}

type BetterAuthInstance = ReturnType<typeof createUserAuth>;

export interface UserAuthRuntime {
  readonly auth: BetterAuthInstance;
  readonly enabledProviders: readonly SignInProvider[];
}

export function createUserAuthFromEnv(env: Env, database: D1Database): BetterAuthInstance {
  return createUserAuthRuntimeFromEnv(env, database).auth;
}

interface CachedUserAuth {
  readonly fingerprint: string;
  readonly runtime: UserAuthRuntime;
}

const userAuthByDatabase = new WeakMap<D1Database, CachedUserAuth>();

function configurationFingerprint(config: NormalizedUserAuthConfig): string {
  return JSON.stringify(config);
}

export function getUserAuthRuntime(env: Env, database: D1Database): UserAuthRuntime {
  const config = normalizeUserAuthConfig(env);
  const fingerprint = configurationFingerprint(config);
  const cached = userAuthByDatabase.get(database);
  if (cached?.fingerprint === fingerprint) {
    return cached.runtime;
  }
  const runtime = createUserAuthRuntime(config, database);
  userAuthByDatabase.set(database, { fingerprint, runtime });
  return runtime;
}

export function getUserAuth(env: Env, database: D1Database): BetterAuthInstance {
  return getUserAuthRuntime(env, database).auth;
}

export type BetterAuthRuntime = BetterAuthInstance;
