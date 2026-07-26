import {
  AdmissionPolicy,
  parseAdmissionAllowlist,
  parseAdmissionBoolean,
} from "./admission-policy";
import { createBrowserAuth } from "./browser-auth";
import { GitHubBrowserAuthProfileResolver } from "./github-browser-auth-profile";
import { GoogleBrowserAuthProfileResolver } from "./google-browser-auth-profile";
import { GitHubOAuthProvider } from "./providers/github";
import { D1BrowserAuthUserProjection } from "../db/browser-auth-users";
import type { Env } from "../types";

const GITHUB_ISSUER = "https://github.com";
const MINIMUM_SECRET_LENGTH = 32;

export class BrowserAuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserAuthConfigurationError";
  }
}

function requireConfig(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new BrowserAuthConfigurationError(`${name} is not configured`);
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
    throw new BrowserAuthConfigurationError("WEB_APP_URL is invalid");
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
    throw new BrowserAuthConfigurationError(
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

export function createBrowserAuthFromEnv(env: Env, database: D1Database) {
  const publicWebOrigin = parsePublicWebOrigin(env.WEB_APP_URL);
  const secret = requireConfig(env.BROWSER_AUTH_SECRET, "BROWSER_AUTH_SECRET");
  if (secret.length < MINIMUM_SECRET_LENGTH) {
    throw new BrowserAuthConfigurationError(
      `BROWSER_AUTH_SECRET must be at least ${MINIMUM_SECRET_LENGTH} characters`
    );
  }

  const githubClientId = requireConfig(env.GITHUB_CLIENT_ID, "GITHUB_CLIENT_ID");
  const githubClientSecret = requireConfig(env.GITHUB_CLIENT_SECRET, "GITHUB_CLIENT_SECRET");
  const admissionPolicy = createAdmissionPolicy(env);
  const githubIdentityResolver = new GitHubOAuthProvider({
    clientId: githubClientId,
    clientSecret: githubClientSecret,
    callbackUri: `${publicWebOrigin}/api/auth/callback/github`,
    issuer: GITHUB_ISSUER,
    userAgent: `${env.APP_NAME?.trim() || "Open-Inspect"} Control Plane`,
  });
  const githubProfile = new GitHubBrowserAuthProfileResolver({
    identityResolver: githubIdentityResolver,
    admissionPolicy,
  });

  const googleClientId = env.GOOGLE_CLIENT_ID?.trim();
  const googleClientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (Boolean(googleClientId) !== Boolean(googleClientSecret)) {
    throw new BrowserAuthConfigurationError(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together"
    );
  }

  const googleProfile =
    googleClientId && googleClientSecret
      ? new GoogleBrowserAuthProfileResolver({
          clientId: googleClientId,
          admissionPolicy,
        })
      : null;

  return createBrowserAuth({
    database,
    publicWebOrigin,
    secret,
    userProjection: new D1BrowserAuthUserProjection(database),
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

type BrowserAuth = ReturnType<typeof createBrowserAuthFromEnv>;

interface CachedBrowserAuth {
  readonly fingerprint: string;
  readonly auth: BrowserAuth;
}

const browserAuthByDatabase = new WeakMap<D1Database, CachedBrowserAuth>();

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

export function getBrowserAuth(env: Env, database: D1Database): BrowserAuth {
  const fingerprint = configurationFingerprint(env);
  const cached = browserAuthByDatabase.get(database);
  if (cached?.fingerprint === fingerprint) {
    return cached.auth;
  }
  const auth = createBrowserAuthFromEnv(env, database);
  browserAuthByDatabase.set(database, { fingerprint, auth });
  return auth;
}

export type BrowserAuthRuntime = BrowserAuth;
