import {
  AdmissionPolicy,
  parseAdmissionAllowlist,
  parseAdmissionBoolean,
} from "./admission-policy";
import { createUserAuth } from "./better-auth";
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

function createAdmissionPolicy(env: Env): AdmissionPolicy {
  return new AdmissionPolicy({
    allowedGitHubUsers: parseAdmissionAllowlist(env.ALLOWED_USERS),
    allowedEmails: parseAdmissionAllowlist(env.ALLOWED_EMAILS),
    allowedEmailDomains: parseAdmissionAllowlist(env.ALLOWED_EMAIL_DOMAINS),
    allowedGitHubOrganizations: parseAdmissionAllowlist(env.ALLOWED_GITHUB_ORGS),
    unsafeAllowAllUsers: parseAdmissionBoolean(env.UNSAFE_ALLOW_ALL_USERS),
  });
}

export function createUserAuthFromEnv(env: Env, database: D1Database) {
  const publicWebOrigin = parsePublicWebOrigin(env.WEB_APP_URL);
  const secret = requireConfig(env.BROWSER_AUTH_SECRET, "BROWSER_AUTH_SECRET");
  if (secret.length < MINIMUM_SECRET_LENGTH) {
    throw new UserAuthConfigurationError(
      `BROWSER_AUTH_SECRET must be at least ${MINIMUM_SECRET_LENGTH} characters`
    );
  }

  const githubClientId = requireConfig(env.GITHUB_CLIENT_ID, "GITHUB_CLIENT_ID");
  const githubClientSecret = requireConfig(env.GITHUB_CLIENT_SECRET, "GITHUB_CLIENT_SECRET");
  const admissionPolicy = createAdmissionPolicy(env);
  const githubIdentityResolver = new GitHubProviderIdentityResolver({
    issuer: GITHUB_ISSUER,
    userAgent: `${env.APP_NAME?.trim() || "Open-Inspect"} Control Plane`,
  });
  const githubProfile = new GitHubSignInProfileResolver({
    identityResolver: githubIdentityResolver,
    admissionPolicy,
  });

  const googleClientId = env.GOOGLE_CLIENT_ID?.trim();
  const googleClientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (Boolean(googleClientId) !== Boolean(googleClientSecret)) {
    throw new UserAuthConfigurationError(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together"
    );
  }

  const googleProfile =
    googleClientId && googleClientSecret
      ? new GoogleSignInProfileResolver({
          clientId: googleClientId,
          admissionPolicy,
        })
      : null;

  return createUserAuth({
    database,
    publicWebOrigin,
    secret,
    userProjection: new D1CanonicalUserProjection(database),
    github: {
      clientId: githubClientId,
      clientSecret: githubClientSecret,
      getUserInfo: githubProfile.getUserInfo,
    },
    ...(googleProfile && googleClientId && googleClientSecret
      ? {
          google: {
            clientId: googleClientId,
            clientSecret: googleClientSecret,
            getUserInfo: googleProfile.getUserInfo,
          },
        }
      : {}),
  });
}

type BetterAuthInstance = ReturnType<typeof createUserAuthFromEnv>;

interface CachedUserAuth {
  readonly fingerprint: string;
  readonly auth: BetterAuthInstance;
}

const userAuthByDatabase = new WeakMap<D1Database, CachedUserAuth>();

function configurationFingerprint(env: Env): string {
  return [
    env.WEB_APP_URL,
    env.BROWSER_AUTH_SECRET,
    env.GITHUB_CLIENT_ID,
    env.GITHUB_CLIENT_SECRET,
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.ALLOWED_USERS,
    env.ALLOWED_EMAILS,
    env.ALLOWED_EMAIL_DOMAINS,
    env.ALLOWED_GITHUB_ORGS,
    env.UNSAFE_ALLOW_ALL_USERS,
  ].join("\u0000");
}

export function getUserAuth(env: Env, database: D1Database): BetterAuthInstance {
  const fingerprint = configurationFingerprint(env);
  const cached = userAuthByDatabase.get(database);
  if (cached?.fingerprint === fingerprint) {
    return cached.auth;
  }
  const auth = createUserAuthFromEnv(env, database);
  userAuthByDatabase.set(database, { fingerprint, auth });
  return auth;
}

export type BetterAuthRuntime = BetterAuthInstance;
