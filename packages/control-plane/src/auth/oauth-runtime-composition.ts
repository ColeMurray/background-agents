import {
  AdmissionPolicy,
  parseAdmissionAllowlist,
  parseAdmissionBoolean,
} from "./admission-policy";
import {
  assertValidAuthEncryptionRoot,
  InvalidAuthEncryptionRootError,
  ProviderCredentialCipher,
  ProviderPkceFlowCipher,
} from "./auth-encryption";
import { BrowserSignInIdentityResolver } from "./browser-sign-in-identity";
import { hashToken } from "./crypto";
import {
  OAuthAuthorizationRequestError,
  OAuthAuthorizationService,
  StaticOAuthClientRegistry,
  WebCryptoOpaqueValueGenerator,
} from "./oauth-authorization-service";
import {
  createOAuthProviderCallbackHandlers,
  OAuthProviderDisabledError,
} from "./oauth-provider-callback-handler";
import {
  OAuthProviderCallbackBindingError,
  OAuthProviderCallbackError,
  OAuthProviderCallbackRequestError,
  OAuthProviderCallbackService,
} from "./oauth-provider-callback-service";
import {
  OAuthProtocolCallbackRedirectError,
  OAuthProtocolGrantError,
  OAuthProtocolRequestError,
  type OAuthProtocolRuntime,
  OAuthProtocolUnavailableError,
} from "./oauth-runtime";
import { GitHubOAuthProvider } from "./providers/github";
import { GoogleOidcProvider } from "./providers/google";
import type { ConfiguredOAuthSignInProviderRegistry } from "./providers/types";
import { base64UrlEncode } from "./encoding";
import {
  BROWSER_SESSION_ABSOLUTE_LIFETIME_MS,
  BROWSER_SESSION_IDLE_LIFETIME_MS,
  BrowserAuthSessionStore,
  BrowserSessionAuthenticationError,
  defaultBrowserAuthSessionStoreDependencies,
  parseBrowserSessionCredential,
} from "../db/browser-auth-sessions";
import { BrowserSignInIdentityStore } from "../db/browser-sign-in-identities";
import {
  OAuthAuthorizationCodeRedemptionError,
  OAuthAuthorizationCodeStore,
} from "../db/oauth-authorization-codes";
import { OAuthFlowStateConsumptionError, OAuthFlowStateStore } from "../db/oauth-flow-state";
import { ProviderCredentialStore } from "../db/provider-credentials";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";

const GITHUB_ISSUER = "https://github.com";
const GOOGLE_ISSUER = "https://accounts.google.com";

export class OAuthRuntimeConfigurationError extends Error {
  constructor(readonly setting: string) {
    super("OAuth runtime is not configured");
    this.name = "OAuthRuntimeConfigurationError";
  }
}

function required(value: string | undefined, setting: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new OAuthRuntimeConfigurationError(setting);
  }
  return normalized;
}

function exactHttpsUrl(value: string, setting: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthRuntimeConfigurationError(setting);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new OAuthRuntimeConfigurationError(setting);
  }
  return value;
}

function workerBaseUrl(value: string | undefined): string {
  const url = exactHttpsUrl(required(value, "WORKER_URL"), "WORKER_URL");
  const parsed = new URL(url);
  if (parsed.search !== "" || parsed.pathname !== "/") {
    throw new OAuthRuntimeConfigurationError("WORKER_URL");
  }
  return parsed.origin;
}

function webRedirectUris(value: string | undefined): string[] {
  const candidates = value
    ?.split(",")
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  if (!candidates || candidates.length === 0) {
    throw new OAuthRuntimeConfigurationError("OAUTH_WEB_REDIRECT_URIS");
  }
  return [
    ...new Set(candidates.map((candidate) => exactHttpsUrl(candidate, "OAUTH_WEB_REDIRECT_URIS"))),
  ];
}

function optionalProviderSecretPair(
  clientId: string | undefined,
  clientSecret: string | undefined
): { clientId: string; clientSecret: string } | null {
  const normalizedClientId = clientId?.trim() ?? "";
  const normalizedClientSecret = clientSecret?.trim() ?? "";
  if (Boolean(normalizedClientId) !== Boolean(normalizedClientSecret)) {
    throw new OAuthRuntimeConfigurationError(
      normalizedClientId ? "GOOGLE_CLIENT_SECRET" : "GOOGLE_CLIENT_ID"
    );
  }
  return normalizedClientId && normalizedClientSecret
    ? { clientId: normalizedClientId, clientSecret: normalizedClientSecret }
    : null;
}

function randomOpaqueValue(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

function encryptionRoot(value: string | undefined): string {
  const rootKey = required(value, "TOKEN_ENCRYPTION_KEY");
  try {
    assertValidAuthEncryptionRoot(rootKey);
  } catch (error) {
    if (error instanceof InvalidAuthEncryptionRootError) {
      throw new OAuthRuntimeConfigurationError("TOKEN_ENCRYPTION_KEY");
    }
    throw error;
  }
  return rootKey;
}

interface ProviderRuntimeConfiguration {
  readonly clients: StaticOAuthClientRegistry;
  readonly providers: ConfiguredOAuthSignInProviderRegistry;
  readonly providerCredentialCipher: ProviderCredentialCipher;
  readonly providerPkceFlowCipher: ProviderPkceFlowCipher;
}

const providerConfigurations = new WeakMap<Env, ProviderRuntimeConfiguration>();
const clock = { now: () => Date.now() };
const idGenerator = { generate: () => crypto.randomUUID() };
const tokenHasher = { hash: hashToken };

function providerConfiguration(env: Env): ProviderRuntimeConfiguration {
  const cached = providerConfigurations.get(env);
  if (cached) return cached;

  const rootKey = encryptionRoot(env.TOKEN_ENCRYPTION_KEY);
  const controlPlaneBaseUrl = workerBaseUrl(env.WORKER_URL);
  const clients = new StaticOAuthClientRegistry(webRedirectUris(env.OAUTH_WEB_REDIRECT_URIS));
  const github = new GitHubOAuthProvider({
    clientId: required(env.GITHUB_CLIENT_ID, "GITHUB_CLIENT_ID"),
    clientSecret: required(env.GITHUB_CLIENT_SECRET, "GITHUB_CLIENT_SECRET"),
    callbackUri: `${controlPlaneBaseUrl}/oauth/callback/github`,
    issuer: GITHUB_ISSUER,
    userAgent: env.APP_NAME?.trim() || "Open-Inspect-Control-Plane",
  });
  const googleConfig = optionalProviderSecretPair(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
  const providers: ConfiguredOAuthSignInProviderRegistry = {
    github,
    ...(googleConfig
      ? {
          google: new GoogleOidcProvider({
            ...googleConfig,
            callbackUri: `${controlPlaneBaseUrl}/oauth/callback/google`,
            issuer: GOOGLE_ISSUER,
          }),
        }
      : {}),
  };

  const configuration = {
    clients,
    providers,
    providerCredentialCipher: new ProviderCredentialCipher(rootKey),
    providerPkceFlowCipher: new ProviderPkceFlowCipher(rootKey),
  };
  providerConfigurations.set(env, configuration);
  return configuration;
}

function createFlowStateStore(
  db: SqlDatabase,
  configuration: ProviderRuntimeConfiguration
): OAuthFlowStateStore {
  return new OAuthFlowStateStore(db, configuration.providerPkceFlowCipher, {
    clock,
    idGenerator,
    tokenHasher,
  });
}

function createAuthorizationCodeStore(db: SqlDatabase): OAuthAuthorizationCodeStore {
  return new OAuthAuthorizationCodeStore(db, {
    clock,
    tokenHasher,
    authorizationCodeGenerator: {
      generate: () => `oi_code_${randomOpaqueValue()}`,
    },
    browserCredentialGenerator: {
      generate: () => `oi_bsess_${randomOpaqueValue()}`,
    },
    idGenerator,
  });
}

function createAuthorizationService(env: Env, db: SqlDatabase): OAuthAuthorizationService {
  const configuration = providerConfiguration(env);
  return new OAuthAuthorizationService({
    clients: configuration.clients,
    providers: configuration.providers,
    flowStateStore: createFlowStateStore(db, configuration),
    opaqueValueGenerator: new WebCryptoOpaqueValueGenerator(),
  });
}

function createCallbackService(env: Env, db: SqlDatabase): OAuthProviderCallbackService {
  const configuration = providerConfiguration(env);
  const providerCredentialStore = new ProviderCredentialStore(
    db,
    configuration.providerCredentialCipher,
    clock
  );
  const identityResolver = new BrowserSignInIdentityResolver({
    clock,
    idGenerator,
    store: new BrowserSignInIdentityStore(db, providerCredentialStore),
  });
  const flowStateStore = createFlowStateStore(db, configuration);
  return new OAuthProviderCallbackService({
    clients: configuration.clients,
    providerHandlers: createOAuthProviderCallbackHandlers({
      flowStateStore,
      providers: configuration.providers,
    }),
    admissionPolicy: new AdmissionPolicy({
      allowedGitHubUsers: parseAdmissionAllowlist(env.ALLOWED_USERS),
      allowedEmails: parseAdmissionAllowlist(env.ALLOWED_EMAILS),
      allowedEmailDomains: parseAdmissionAllowlist(env.ALLOWED_EMAIL_DOMAINS),
      allowedGitHubOrganizations: parseAdmissionAllowlist(env.ALLOWED_GITHUB_ORGS),
      unsafeAllowAllUsers: parseAdmissionBoolean(env.UNSAFE_ALLOW_ALL_USERS),
    }),
    identityResolver,
    authorizationCodeStore: createAuthorizationCodeStore(db),
  });
}

async function authorize(
  env: Env,
  db: SqlDatabase,
  request: Parameters<OAuthProtocolRuntime["authorize"]>[0]
): Promise<URL> {
  try {
    return await createAuthorizationService(env, db).authorize(request);
  } catch (error) {
    if (error instanceof OAuthAuthorizationRequestError) {
      throw new OAuthProtocolRequestError(error.code);
    }
    if (error instanceof OAuthRuntimeConfigurationError) {
      throw new OAuthProtocolUnavailableError(error.setting);
    }
    throw error;
  }
}

async function completeCallback<T>(
  env: Env,
  db: SqlDatabase,
  operation: (service: OAuthProviderCallbackService) => Promise<T>
): Promise<T> {
  try {
    return await operation(createCallbackService(env, db));
  } catch (error) {
    if (error instanceof OAuthProviderCallbackError) {
      throw new OAuthProtocolCallbackRedirectError(error.failure, error.redirectUri);
    }
    if (error instanceof OAuthRuntimeConfigurationError) {
      throw new OAuthProtocolUnavailableError(error.setting);
    }
    if (
      error instanceof OAuthFlowStateConsumptionError ||
      error instanceof OAuthProviderCallbackBindingError ||
      error instanceof OAuthProviderCallbackRequestError ||
      error instanceof OAuthProviderDisabledError
    ) {
      throw new OAuthProtocolRequestError("invalid_request");
    }
    throw error;
  }
}

export function createOAuthProtocolRuntime(env: Env, db: SqlDatabase): OAuthProtocolRuntime {
  return {
    authorize: (request) => authorize(env, db, request),
    completeAuthorization: async (provider, input) =>
      completeCallback(env, db, (service) => service.completeAuthorization(provider, input)),
    completeDenial: async (provider, state) =>
      completeCallback(env, db, (service) => service.completeDenial(provider, state)),
    redeemAuthorizationCode: async (input) => {
      try {
        const created = await createAuthorizationCodeStore(db).redeem(input);
        return {
          accessToken: created.credential,
          expiresIn: BROWSER_SESSION_ABSOLUTE_LIFETIME_MS / 1000,
          idleExpiresIn: BROWSER_SESSION_IDLE_LIFETIME_MS / 1000,
        };
      } catch (error) {
        if (error instanceof OAuthAuthorizationCodeRedemptionError) {
          throw new OAuthProtocolGrantError(error.rejection);
        }
        throw error;
      }
    },
    revokeBrowserSession: async (token) => {
      try {
        const browserSessionStore = new BrowserAuthSessionStore(db, {
          ...defaultBrowserAuthSessionStoreDependencies,
          clock,
          tokenHasher,
        });
        return await browserSessionStore.revoke(parseBrowserSessionCredential(token), "logout");
      } catch (error) {
        if (error instanceof BrowserSessionAuthenticationError) {
          return false;
        }
        throw error;
      }
    },
  };
}
