import { createModalClient } from "./client";
import { createDaytonaRestClient } from "./daytona-rest-client";
import { createOpenComputerRestClient } from "./opencomputer-rest-client";
import { resolveSandboxBackendName, type SandboxBackendName } from "./provider-name";
import type { SandboxProvider } from "./provider";
import { createDaytonaProvider, type DaytonaSandboxProvider } from "./providers/daytona-provider";
import { createModalProvider, type ModalSandboxProvider } from "./providers/modal-provider";
import {
  createOpenComputerProvider,
  type OpenComputerSandboxProvider,
} from "./providers/opencomputer-provider";
import {
  createDefaultIsloSource,
  createIsloProvider,
  type IsloSandboxProvider,
} from "./providers/islo-provider";
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

function createIsloProviderFromEnv(env: Env): IsloSandboxProvider {
  if (!env.ISLO_API_KEY) {
    throw new Error("ISLO_API_KEY is required when SANDBOX_PROVIDER=islo");
  }

  return createIsloProvider({
    apiKey: env.ISLO_API_KEY,
    baseUrl: env.ISLO_BASE_URL,
    baseSource: createDefaultIsloSource(env.ISLO_BASE_SNAPSHOT, env.ISLO_BASE_IMAGE),
    lifecycle: parseIsloLifecyclePolicy(env),
    vcpus: parsePositiveIntegerEnv("ISLO_VCPUS", env.ISLO_VCPUS),
    memoryMb: parsePositiveIntegerEnv("ISLO_MEMORY_MB", env.ISLO_MEMORY_MB),
    diskGb: parsePositiveIntegerEnv("ISLO_DISK_GB", env.ISLO_DISK_GB),
    workdir: env.ISLO_WORKDIR,
    startCommand: parseCommandEnv(env.ISLO_START_COMMAND),
    startUser: env.ISLO_START_USER,
    gatewayProfile: env.ISLO_GATEWAY_PROFILE,
    shareTtlSeconds: parsePositiveIntegerEnv("ISLO_SHARE_TTL_SECONDS", env.ISLO_SHARE_TTL_SECONDS),
    scmProvider: resolveScmProviderFromEnv(env.SCM_PROVIDER),
    codeServerPasswordSecret: env.ISLO_API_KEY,
  });
}

export function createSandboxProviderFromEnv(env: Env, backend: "daytona"): DaytonaSandboxProvider;
export function createSandboxProviderFromEnv(env: Env, backend: "modal"): ModalSandboxProvider;
export function createSandboxProviderFromEnv(env: Env, backend: "vercel"): VercelSandboxProvider;
export function createSandboxProviderFromEnv(
  env: Env,
  backend: "opencomputer"
): OpenComputerSandboxProvider;
export function createSandboxProviderFromEnv(env: Env, backend: "islo"): IsloSandboxProvider;
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
    case "islo":
      return createIsloProviderFromEnv(env);
    case "vercel":
      return createVercelProviderFromEnv(env);
    case "opencomputer":
      return createOpenComputerProviderFromEnv(env);
    case "modal":
      return createModalProviderFromEnv(env);
  }
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

function parsePositiveIntegerEnv(name: string, value: string | undefined): number | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseIsloLifecyclePolicy(env: Env) {
  const enabledRaw = env.ISLO_LIFECYCLE_ENABLED?.trim().toLowerCase();
  if (enabledRaw === "false" || enabledRaw === "0" || enabledRaw === "no") return undefined;

  return {
    pause_after_idle:
      parsePositiveIntegerEnv(
        "ISLO_LIFECYCLE_PAUSE_AFTER_IDLE_SECONDS",
        env.ISLO_LIFECYCLE_PAUSE_AFTER_IDLE_SECONDS
      ) ?? 3600,
    pause_after: parsePositiveIntegerEnv(
      "ISLO_LIFECYCLE_PAUSE_AFTER_SECONDS",
      env.ISLO_LIFECYCLE_PAUSE_AFTER_SECONDS
    ),
    delete_after: parsePositiveIntegerEnv(
      "ISLO_LIFECYCLE_DELETE_AFTER_SECONDS",
      env.ISLO_LIFECYCLE_DELETE_AFTER_SECONDS
    ),
    ...(env.ISLO_LIFECYCLE_AUTO_RESUME
      ? { auto_resume: parseIsloAutoResumePolicy(env.ISLO_LIFECYCLE_AUTO_RESUME) }
      : {}),
  };
}

function parseIsloAutoResumePolicy(value: string): "never" | "on_activity" {
  const raw = value.trim();
  if (raw === "never" || raw === "on_activity") return raw;
  throw new Error("ISLO_LIFECYCLE_AUTO_RESUME must be either never or on_activity");
}

function parseCommandEnv(value: string | undefined): string[] | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(
        `ISLO_START_COMMAND must be valid JSON when it starts with "[": ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((part) => typeof part === "string" && part.length > 0)
    ) {
      return parsed;
    }
    throw new Error("ISLO_START_COMMAND JSON must be a non-empty string array");
  }

  return ["sh", "-lc", trimmed];
}
