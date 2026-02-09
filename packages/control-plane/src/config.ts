/**
 * Environment configuration for the control plane.
 *
 * All configuration is loaded from process.env at startup.
 * This replaces the Cloudflare Workers Env bindings.
 */

export interface Config {
  /** HTTP server port */
  port: number;
  /** PostgreSQL connection string */
  databaseUrl: string;
  /** Redis connection string */
  redisUrl: string;
  /** GitHub OAuth client ID */
  githubClientId?: string;
  /** GitHub OAuth client secret */
  githubClientSecret?: string;
  /** AES-256 encryption key (base64) for token encryption */
  tokenEncryptionKey: string;
  /** AES-256 encryption key (base64) for repo secrets */
  repoSecretsEncryptionKey?: string;
  /** Shared HMAC secret for internal API authentication (replaces MODAL_API_SECRET) */
  internalApiSecret: string;
  /** GitHub App ID */
  githubAppId?: string;
  /** GitHub App private key (PEM, PKCS#8 format) */
  githubAppPrivateKey?: string;
  /** GitHub App installation ID */
  githubAppInstallationId?: string;
  /** Deployment name for identification */
  deploymentName: string;
  /** Source control provider for this deployment (default: github) */
  scmProvider?: string;
  /** Base URL for this control plane (for callbacks) */
  workerUrl?: string;
  /** Base URL for the web app (for PR links) */
  webAppUrl?: string;
  /** Docker image for sandbox pods */
  sandboxImage: string;
  /** Sandbox inactivity timeout in milliseconds (default: 600000 = 10 min) */
  sandboxInactivityTimeoutMs: number;
  /** Log level: "debug" | "info" | "warn" | "error" (default: "info") */
  logLevel: string;
  /** Internal callback secret for signing callbacks to other services */
  internalCallbackSecret?: string;
}

/**
 * Load configuration from process.env.
 *
 * Required variables will throw at startup if missing, so failures are
 * loud and immediate rather than deferred to first request.
 */
export function loadConfig(): Config {
  const env = process.env;

  const port = parseInt(env.PORT || "8080", 10);
  const databaseUrl = requireEnv("DATABASE_URL");
  const redisUrl = requireEnv("REDIS_URL");
  const tokenEncryptionKey = requireEnv("TOKEN_ENCRYPTION_KEY");
  const internalApiSecret = requireEnv("INTERNAL_API_SECRET");
  const deploymentName = env.DEPLOYMENT_NAME || "open-inspect";
  const sandboxImage = env.SANDBOX_IMAGE || "open-inspect-sandbox:latest";
  const sandboxInactivityTimeoutMs = parseInt(
    env.SANDBOX_INACTIVITY_TIMEOUT_MS || "600000",
    10,
  );
  const logLevel = env.LOG_LEVEL || "info";

  return {
    port,
    databaseUrl,
    redisUrl,
    githubClientId: env.GITHUB_CLIENT_ID,
    githubClientSecret: env.GITHUB_CLIENT_SECRET,
    tokenEncryptionKey,
    repoSecretsEncryptionKey: env.REPO_SECRETS_ENCRYPTION_KEY,
    internalApiSecret,
    githubAppId: env.GITHUB_APP_ID,
    githubAppPrivateKey: env.GITHUB_APP_PRIVATE_KEY,
    githubAppInstallationId: env.GITHUB_APP_INSTALLATION_ID,
    deploymentName,
    scmProvider: env.SCM_PROVIDER,
    workerUrl: env.WORKER_URL,
    webAppUrl: env.WEB_APP_URL,
    sandboxImage,
    sandboxInactivityTimeoutMs,
    logLevel,
    internalCallbackSecret: env.INTERNAL_CALLBACK_SECRET,
  };
}

/**
 * Read a required environment variable or throw.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}
