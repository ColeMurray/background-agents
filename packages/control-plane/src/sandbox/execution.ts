import {
  DEFAULT_DOCKER_CPU_CORES,
  DEFAULT_DOCKER_MEMORY_MIB,
  sessionSandboxExecutionSchema,
  type SessionSandboxExecution,
} from "@open-inspect/shared/types/sandbox-execution";
import {
  omitUnsupportedSandboxSettings,
  type SandboxSettings,
} from "@open-inspect/shared/types/integrations";
import { IntegrationSettingsStore } from "../db/integration-settings";
import type { SqlDatabase } from "../db/sql-database";
import type { EnvConfig } from "../types";
import { resolveSandboxBackendName } from "./provider-name";
import { normalizeSandboxSettings } from "./settings";

export interface SandboxLaunchSettingsSnapshot {
  readonly settings: SandboxSettings;
  readonly scopeAllowed: boolean;
  readonly repository: string | null;
}

export interface SandboxLaunchSpec {
  readonly settings: Readonly<Omit<SandboxSettings, "dockerEnabled">>;
  readonly execution: Readonly<SessionSandboxExecution>;
}

export interface SandboxLaunchOptions {
  readonly dockerEnabled?: boolean;
  readonly inherited?: {
    readonly execution: SessionSandboxExecution;
    readonly sandboxTimeoutMs?: number;
    readonly finalSnapshotBufferMs?: number;
  };
}

export class SandboxExecutionError extends Error {
  constructor(
    readonly code: "docker_not_available" | "docker_not_allowed" | "invalid_sandbox_execution",
    message: string,
    readonly status: 400 | 403 | 503
  ) {
    super(message);
    this.name = "SandboxExecutionError";
  }
}

/** Read before tolerant UI settings can erase an invalid execution requirement. */
export async function readSandboxExecutionSettings(
  db: SqlDatabase,
  repo: string | null,
  environmentId?: string | null
): Promise<SandboxLaunchSettingsSnapshot> {
  try {
    const store = new IntegrationSettingsStore(db, { strictSandboxExecution: true });
    if (repo) {
      const resolved = await store.getResolvedConfig("sandbox", repo, environmentId);
      return {
        settings: resolved.settings,
        repository: repo,
        scopeAllowed:
          resolved.enabledRepos === null || resolved.enabledRepos.includes(repo.toLowerCase()),
      };
    }
    const global = await store.getGlobal("sandbox");
    // A repository allowlist cannot grant a repository-less session access.
    return {
      settings: global?.defaults ?? {},
      scopeAllowed: global?.enabledRepos == null,
      repository: null,
    };
  } catch {
    throw new SandboxExecutionError(
      "invalid_sandbox_execution",
      "Sandbox execution settings could not be validated",
      503
    );
  }
}

export function resolveSandboxLaunchSpec(
  env: Pick<EnvConfig, "SANDBOX_PROVIDER" | "ENABLE_MODAL_VM_SANDBOXES">,
  snapshot: SandboxLaunchSettingsSnapshot,
  options: SandboxLaunchOptions = {}
): SandboxLaunchSpec {
  const execution = resolveSandboxExecution(
    env,
    snapshot.settings,
    snapshot.scopeAllowed,
    options.dockerEnabled,
    options.inherited?.execution
  );
  const projected: SandboxSettings =
    snapshot.scopeAllowed || snapshot.repository === null ? { ...snapshot.settings } : {};

  if (options.inherited) {
    delete projected.sandboxTimeoutMs;
    delete projected.finalSnapshotBufferMs;
    if (options.inherited.sandboxTimeoutMs !== undefined) {
      projected.sandboxTimeoutMs = options.inherited.sandboxTimeoutMs;
    }
    if (options.inherited.finalSnapshotBufferMs !== undefined) {
      projected.finalSnapshotBufferMs = options.inherited.finalSnapshotBufferMs;
    }
  }
  if (execution.profile === "docker-v1") {
    projected.cpuCores = execution.cpuCores;
    projected.memoryMib = execution.memoryMib;
  }
  const normalized = normalizeSandboxSettings(projected, {
    invalid: "omit",
    strictExecution: true,
  });
  const supported = omitUnsupportedSandboxSettings(
    normalized,
    resolveSandboxBackendName(env.SANDBOX_PROVIDER)
  );
  const { dockerEnabled: _dockerEnabled, ...effective } = supported;
  if (effective.tunnelPorts) {
    effective.tunnelPorts = [...effective.tunnelPorts];
    Object.freeze(effective.tunnelPorts);
  }

  return Object.freeze({
    settings: Object.freeze(effective),
    execution: Object.freeze(execution),
  });
}

/** Admission for new Sessions/children/builds; never used to reinterpret an existing Session. */
export function resolveSandboxExecution(
  env: Pick<EnvConfig, "SANDBOX_PROVIDER" | "ENABLE_MODAL_VM_SANDBOXES">,
  settings: SandboxSettings,
  scopeAllowed: boolean,
  override?: boolean,
  inherited?: SessionSandboxExecution
): SessionSandboxExecution {
  if (override !== undefined && typeof override !== "boolean") {
    throw new SandboxExecutionError(
      "invalid_sandbox_execution",
      "dockerEnabled must be a boolean",
      400
    );
  }
  const frozen =
    inherited === undefined ? undefined : sessionSandboxExecutionSchema.parse(inherited);
  const required = frozen
    ? frozen.profile === "docker-v1"
    : (override ?? settings.dockerEnabled ?? false);
  if (!required) return { profile: "default" };
  if (!scopeAllowed) {
    throw new SandboxExecutionError(
      "docker_not_allowed",
      "Docker is not allowed for this repository scope",
      403
    );
  }
  if ((env.SANDBOX_PROVIDER ?? "modal") !== "modal" || env.ENABLE_MODAL_VM_SANDBOXES !== "true") {
    throw new SandboxExecutionError(
      "docker_not_available",
      "Docker-enabled Modal VM sessions are unavailable",
      503
    );
  }
  return (
    frozen ??
    sessionSandboxExecutionSchema.parse({
      profile: "docker-v1",
      provider: "modal",
      cpuCores: settings.cpuCores ?? DEFAULT_DOCKER_CPU_CORES,
      memoryMib: settings.memoryMib ?? DEFAULT_DOCKER_MEMORY_MIB,
    })
  );
}
