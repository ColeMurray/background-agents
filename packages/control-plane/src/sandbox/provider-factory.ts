import { createModalClient } from "./client";
import { createDaytonaRestClient } from "./daytona-rest-client";
import { createE2BRestClient } from "./e2b-rest-client";
import { createOpenComputerRestClient } from "./opencomputer-rest-client";
import { createSuperserveRestClient } from "./superserve-rest-client";
import { resolveSandboxBackendName, type SandboxBackendName } from "./provider-name";
import type { SandboxProvider } from "./provider";
import { createDaytonaProvider, type DaytonaSandboxProvider } from "./providers/daytona-provider";
import {
  createE2BProvider,
  DEFAULT_E2B_AUTO_PAUSE,
  DEFAULT_E2B_SANDBOX_TIMEOUT_SECONDS,
  type E2BSandboxProvider,
} from "./providers/e2b-provider";
import { createModalProvider, type ModalSandboxProvider } from "./providers/modal-provider";
import {
  createOpenComputerProvider,
  type OpenComputerSandboxProvider,
} from "./providers/opencomputer-provider";
import {
  createSuperserveProvider,
  type SuperserveSandboxProvider,
} from "./providers/superserve-provider";
import { createVercelSandboxClient } from "./providers/vercel/client";
import { createVercelProvider, type VercelSandboxProvider } from "./providers/vercel/provider";
import { resolveScmProviderFromEnv } from "../source-control";
import type { Env } from "../types";

function createModalProviderFromEnv(env: Env): ModalSandboxProvider {
  if (!env.MODAL_API_SECRET || !env.MODAL_WORKSPACE) {
    throw new Error(
      "MODAL_API_SECRET and MODAL_WORKSPACE are required when SANDBOX_PROVIDER=modal"
    );
  }

  const client = createModalClient(
    env.MODAL_API_SECRET,
    env.MODAL_WORKSPACE,
    env.MODAL_ENVIRONMENT_WEB_SUFFIX
  );

  return createModalProvider(client);
}

function createVercelProviderFromEnv(env: Env): VercelSandboxProvider {
  if (!env.VERCEL_TOKEN || !env.VERCEL_PROJECT_ID) {
    throw new Error("VERCEL_TOKEN and VERCEL_PROJECT_ID are required when SANDBOX_PROVIDER=vercel");
  }

  const client = createVercelSandboxClient({
    token: env.VERCEL_TOKEN,
    projectId: env.VERCEL_PROJECT_ID,
    teamId: env.VERCEL_TEAM_ID,
    apiBaseUrl: env.VERCEL_SANDBOX_API_BASE_URL,
  });

  return createVercelProvider(client, {
    scmProvider: resolveScmProviderFromEnv(env.SCM_PROVIDER),
    token: env.VERCEL_TOKEN,
    teamId: env.VERCEL_TEAM_ID,
    apiBaseUrl: env.VERCEL_SANDBOX_API_BASE_URL,
    baseSnapshotId: env.VERCEL_BASE_SNAPSHOT_ID,
    baseSnapshotName: env.VERCEL_BASE_SNAPSHOT_NAME,
    runtime: env.VERCEL_RUNTIME,
    snapshotExpirationMs: parseNumericEnv(
      "VERCEL_SNAPSHOT_EXPIRATION_MS",
      env.VERCEL_SNAPSHOT_EXPIRATION_MS,
      0
    ),
    codeServerPasswordSecret: env.VERCEL_TOKEN,
  });
}

function createOpenComputerProviderFromEnv(env: Env): OpenComputerSandboxProvider {
  if (!env.OPENCOMPUTER_API_URL || !env.OPENCOMPUTER_API_KEY || !env.OPENCOMPUTER_TEMPLATE) {
    throw new Error(
      "OPENCOMPUTER_API_URL, OPENCOMPUTER_API_KEY, and OPENCOMPUTER_TEMPLATE are required when SANDBOX_PROVIDER=opencomputer"
    );
  }

  const client = createOpenComputerRestClient({
    apiUrl: env.OPENCOMPUTER_API_URL,
    apiKey: env.OPENCOMPUTER_API_KEY,
    template: env.OPENCOMPUTER_TEMPLATE,
  });

  return createOpenComputerProvider(client, {
    scmProvider: resolveScmProviderFromEnv(env.SCM_PROVIDER),
    codeServerPasswordSecret: env.OPENCOMPUTER_API_KEY,
    llmEnvVars: {
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    },
  });
}

function createDaytonaProviderFromEnv(env: Env): DaytonaSandboxProvider {
  if (!env.DAYTONA_API_URL || !env.DAYTONA_API_KEY || !env.DAYTONA_BASE_SNAPSHOT) {
    throw new Error(
      "DAYTONA_API_URL, DAYTONA_API_KEY, and DAYTONA_BASE_SNAPSHOT are required when SANDBOX_PROVIDER=daytona"
    );
  }

  const client = createDaytonaRestClient({
    apiUrl: env.DAYTONA_API_URL,
    apiKey: env.DAYTONA_API_KEY,
    target: env.DAYTONA_TARGET,
    baseSnapshot: env.DAYTONA_BASE_SNAPSHOT,
    autoStopIntervalMinutes: parseNumericEnv(
      "DAYTONA_AUTO_STOP_INTERVAL_MINUTES",
      env.DAYTONA_AUTO_STOP_INTERVAL_MINUTES,
      120
    ),
    autoArchiveIntervalMinutes: parseNumericEnv(
      "DAYTONA_AUTO_ARCHIVE_INTERVAL_MINUTES",
      env.DAYTONA_AUTO_ARCHIVE_INTERVAL_MINUTES,
      10080
    ),
  });

  return createDaytonaProvider(client, {
    scmProvider: resolveScmProviderFromEnv(env.SCM_PROVIDER),
    gitlabAccessToken: env.GITLAB_ACCESS_TOKEN,
    codeServerPasswordSecret: env.DAYTONA_API_KEY,
  });
}

function createE2BProviderFromEnv(env: Env): E2BSandboxProvider {
  if (!env.E2B_API_KEY || !env.E2B_TEMPLATE_ID) {
    throw new Error("E2B_API_KEY and E2B_TEMPLATE_ID are required when SANDBOX_PROVIDER=e2b");
  }

  const client = createE2BRestClient({
    apiUrl: env.E2B_API_URL || "https://api.e2b.app",
    apiKey: env.E2B_API_KEY,
    templateId: env.E2B_TEMPLATE_ID,
  });

  return createE2BProvider(client, {
    scmProvider: resolveScmProviderFromEnv(env.SCM_PROVIDER),
    codeServerPasswordSecret: env.E2B_API_KEY,
    sandboxTimeoutSeconds: parseNumericEnv(
      "E2B_SANDBOX_TIMEOUT_SECONDS",
      env.E2B_SANDBOX_TIMEOUT_SECONDS,
      DEFAULT_E2B_SANDBOX_TIMEOUT_SECONDS
    ),
    autoPause: parseBooleanEnv("E2B_AUTO_PAUSE", env.E2B_AUTO_PAUSE, DEFAULT_E2B_AUTO_PAUSE),
  });
}

function createSuperserveProviderFromEnv(env: Env): SuperserveSandboxProvider {
  if (
    !env.SUPERSERVE_API_URL ||
    !env.SUPERSERVE_API_KEY ||
    !env.SUPERSERVE_TEMPLATE ||
    !env.SUPERSERVE_SANDBOX_HOST
  ) {
    throw new Error(
      "SUPERSERVE_API_URL, SUPERSERVE_API_KEY, SUPERSERVE_TEMPLATE, and SUPERSERVE_SANDBOX_HOST are required when SANDBOX_PROVIDER=superserve"
    );
  }

  const allowOut = parseListEnv(env.SUPERSERVE_NETWORK_ALLOW_OUT);
  const denyOut = parseListEnv(env.SUPERSERVE_NETWORK_DENY_OUT);
  const client = createSuperserveRestClient({
    apiUrl: env.SUPERSERVE_API_URL,
    apiKey: env.SUPERSERVE_API_KEY,
    template: env.SUPERSERVE_TEMPLATE,
    sandboxHost: env.SUPERSERVE_SANDBOX_HOST,
    autoDeleteSeconds: parseOptionalIntegerEnv(
      "SUPERSERVE_AUTO_DELETE_SECONDS",
      env.SUPERSERVE_AUTO_DELETE_SECONDS,
      0,
      2_592_000
    ),
    ...(allowOut.length > 0 || denyOut.length > 0 ? { network: { allowOut, denyOut } } : {}),
  });

  return createSuperserveProvider(client, {
    scmProvider: resolveScmProviderFromEnv(env.SCM_PROVIDER),
    codeServerPasswordSecret: env.SUPERSERVE_API_KEY,
    llmEnvVars: {
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    },
  });
}

export function createSandboxProviderFromEnv(env: Env, backend: "daytona"): DaytonaSandboxProvider;
export function createSandboxProviderFromEnv(env: Env, backend: "e2b"): E2BSandboxProvider;
export function createSandboxProviderFromEnv(env: Env, backend: "modal"): ModalSandboxProvider;
export function createSandboxProviderFromEnv(env: Env, backend: "vercel"): VercelSandboxProvider;
export function createSandboxProviderFromEnv(
  env: Env,
  backend: "opencomputer"
): OpenComputerSandboxProvider;
export function createSandboxProviderFromEnv(
  env: Env,
  backend: "superserve"
): SuperserveSandboxProvider;
export function createSandboxProviderFromEnv(
  env: Env,
  backend?: SandboxBackendName
): SandboxProvider;
export function createSandboxProviderFromEnv(
  env: Env,
  backend: SandboxBackendName = resolveSandboxBackendName(env.SANDBOX_PROVIDER)
): SandboxProvider {
  switch (backend) {
    case "daytona":
      return createDaytonaProviderFromEnv(env);
    case "vercel":
      return createVercelProviderFromEnv(env);
    case "opencomputer":
      return createOpenComputerProviderFromEnv(env);
    case "e2b":
      return createE2BProviderFromEnv(env);
    case "superserve":
      return createSuperserveProviderFromEnv(env);
    case "modal":
      return createModalProviderFromEnv(env);
  }
}

function parseOptionalIntegerEnv(
  name: string,
  value: string | undefined,
  minimum: number,
  maximum: number
): number | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseListEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseNumericEnv(name: string, value: string | undefined, defaultValue: number): number {
  const raw = value?.trim();
  if (!raw) return defaultValue;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a valid number`);
  }
  return parsed;
}

function parseBooleanEnv(name: string, value: string | undefined, defaultValue: boolean): boolean {
  const raw = value?.trim().toLowerCase();
  if (!raw) return defaultValue;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${name} must be a valid boolean`);
}
