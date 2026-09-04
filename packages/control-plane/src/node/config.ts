/**
 * The Node host's configuration from the process environment.
 *
 * `EnvConfig` (types.ts) is the deployment's configuration on every host:
 * on Workers each field is a binding Terraform declares; here each is a
 * process environment variable of the same name, so one `.env` describes
 * a deployment on either. The key table below is checked against the type
 * at compile time, so a field added to `EnvConfig` must be added here too.
 *
 * An empty variable counts as unset, as `FOO=` in an env file means "no
 * value" rather than "the empty string".
 *
 * The host's own settings (`PORT`, `HOST`, `DATA_DIR`, `MIGRATIONS_DIR`,
 * `SHUTDOWN_TIMEOUT_MS`) have no Workers counterpart and are read apart.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EnvConfig } from "../types";

/** A source of configuration values, `process.env` in production. */
export type ConfigSource = Record<string, string | undefined>;

/** Every `EnvConfig` field. `satisfies` fails if the table and the type ever disagree. */
const ENV_CONFIG_KEYS = {
  GITHUB_CLIENT_ID: true,
  GITHUB_CLIENT_SECRET: true,
  GOOGLE_CLIENT_ID: true,
  GOOGLE_CLIENT_SECRET: true,
  BROWSER_AUTH_SECRET: true,
  TOKEN_ENCRYPTION_KEY: true,
  PROVIDER_ACCOUNTS_ENCRYPTION_KEY: true,
  REPO_SECRETS_ENCRYPTION_KEY: true,
  MODAL_TOKEN_ID: true,
  MODAL_TOKEN_SECRET: true,
  MODAL_API_SECRET: true,
  ANTHROPIC_API_KEY: true,
  DAYTONA_API_KEY: true,
  OPENCOMPUTER_API_KEY: true,
  VERCEL_TOKEN: true,
  IMAGE_CALLBACK_TOKEN_PEPPER: true,
  SERVICE_AUTH_SECRET_WEB: true,
  SERVICE_AUTH_SECRET_SLACK_BOT: true,
  SERVICE_AUTH_SECRET_GITHUB_BOT: true,
  SERVICE_AUTH_SECRET_LINEAR_BOT: true,
  SLACK_BOT_TOKEN: true,
  GITHUB_APP_ID: true,
  GITHUB_APP_PRIVATE_KEY: true,
  GITHUB_APP_INSTALLATION_ID: true,
  GITLAB_ACCESS_TOKEN: true,
  GITLAB_NAMESPACE: true,
  DEPLOYMENT_NAME: true,
  APP_NAME: true,
  GITHUB_BOT_USERNAME: true,
  SCM_PROVIDER: true,
  WORKER_URL: true,
  WEB_APP_URL: true,
  ALLOWED_USERS: true,
  ALLOWED_EMAIL_DOMAINS: true,
  ALLOWED_EMAILS: true,
  ALLOWED_GITHUB_ORGS: true,
  UNSAFE_ALLOW_ALL_USERS: true,
  CF_ACCOUNT_ID: true,
  SANDBOX_PROVIDER: true,
  MODAL_WORKSPACE: true,
  MODAL_ENVIRONMENT: true,
  MODAL_ENVIRONMENT_WEB_SUFFIX: true,
  DAYTONA_API_URL: true,
  DAYTONA_BASE_SNAPSHOT: true,
  DAYTONA_AUTO_STOP_INTERVAL_MINUTES: true,
  DAYTONA_AUTO_ARCHIVE_INTERVAL_MINUTES: true,
  DAYTONA_TARGET: true,
  OPENCOMPUTER_API_URL: true,
  OPENCOMPUTER_TEMPLATE: true,
  VERCEL_PROJECT_ID: true,
  VERCEL_TEAM_ID: true,
  VERCEL_BASE_SNAPSHOT_ID: true,
  VERCEL_BASE_SNAPSHOT_NAME: true,
  VERCEL_RUNTIME: true,
  VERCEL_SANDBOX_API_BASE_URL: true,
  VERCEL_SNAPSHOT_EXPIRATION_MS: true,
  E2B_API_KEY: true,
  E2B_API_URL: true,
  E2B_TEMPLATE_ID: true,
  E2B_SANDBOX_TIMEOUT_SECONDS: true,
  E2B_AUTO_PAUSE: true,
  SANDBOX_INACTIVITY_TIMEOUT_MS: true,
  EXECUTION_TIMEOUT_MS: true,
  SECRETS_CAP_ENFORCEMENT: true,
  LOG_LEVEL: true,
} as const satisfies Record<keyof EnvConfig, true>;

/** The `EnvConfig` fields the type does not mark optional. */
type RequiredEnvConfigKey = {
  [K in keyof EnvConfig]-?: undefined extends EnvConfig[K] ? never : K;
}[keyof EnvConfig];

/** The required fields, checked against the type like the table above. */
const REQUIRED_ENV_CONFIG_KEYS = {
  DEPLOYMENT_NAME: true,
  GITHUB_BOT_USERNAME: true,
  TOKEN_ENCRYPTION_KEY: true,
  PROVIDER_ACCOUNTS_ENCRYPTION_KEY: true,
} as const satisfies Record<RequiredEnvConfigKey, true>;

/**
 * The deployment's configuration from `source`. Fails naming every required
 * variable that is missing, so one boot reports the whole gap. Encryption
 * keys are validated by `env-validation` once the environment is built.
 */
export function readEnvConfig(source: ConfigSource): EnvConfig {
  const config: Partial<Record<keyof EnvConfig, string>> = {};
  for (const key of Object.keys(ENV_CONFIG_KEYS) as (keyof EnvConfig)[]) {
    const value = source[key];
    if (value !== undefined && value !== "") config[key] = value;
  }
  const missing = Object.keys(REQUIRED_ENV_CONFIG_KEYS).filter(
    (key) => config[key as keyof EnvConfig] === undefined
  );
  if (missing.length > 0) {
    throw new Error(`Missing required configuration: ${missing.join(", ")}`);
  }
  return config as EnvConfig;
}

/** What the process itself needs: where to listen and where its files live. */
export interface NodeHostSettings {
  /** Interface to listen on; `0.0.0.0` unless `HOST` says otherwise. */
  host: string;
  /** `PORT`; 8787 unless set, the port the Worker's local dev server uses. */
  port: number;
  /** `DATA_DIR`: the global store, the session files, and the host alarm index live here. */
  dataDir: string;
  /** `MIGRATIONS_DIR`: the D1 migration files, applied to the global store at boot. */
  migrationsDir: string;
  /** `SHUTDOWN_TIMEOUT_MS`: how long a drain waits for work before the host is forced down. */
  shutdownTimeoutMs: number;
}

const DEFAULT_PORT = 8787;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * The migrations as the repository lays them out, relative to this module:
 * `src/node` and the bundle's `dist/node` sit at the same depth below the
 * repository root. A container sets `MIGRATIONS_DIR` explicitly.
 */
export const DEFAULT_MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../terraform/d1/migrations"
);

/** The host's settings from `source`; `DATA_DIR` is the one with no default. */
export function readNodeHostSettings(source: ConfigSource): NodeHostSettings {
  const dataDir = present(source.DATA_DIR);
  if (dataDir === undefined) {
    throw new Error("DATA_DIR is required: the directory that holds the host's databases");
  }
  return {
    host: present(source.HOST) ?? "0.0.0.0",
    port: integer("PORT", source.PORT, DEFAULT_PORT),
    dataDir: resolve(dataDir),
    migrationsDir: resolve(present(source.MIGRATIONS_DIR) ?? DEFAULT_MIGRATIONS_DIR),
    shutdownTimeoutMs: integer(
      "SHUTDOWN_TIMEOUT_MS",
      source.SHUTDOWN_TIMEOUT_MS,
      DEFAULT_SHUTDOWN_TIMEOUT_MS
    ),
  };
}

function present(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

function integer(name: string, value: string | undefined, fallback: number): number {
  const raw = present(value);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer, got ${raw}`);
  return Number(raw);
}
