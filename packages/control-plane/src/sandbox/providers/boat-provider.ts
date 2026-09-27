import { supportsConfigurableSandboxTimeout } from "@open-inspect/shared/types/integrations";
import { createLogger } from "../../logger";
import type { SourceControlProviderName } from "../../source-control";
import {
  BoatApiError,
  BoatConflictError,
  BoatNotFoundError,
  type BoatRestClient,
  type BoatSandbox,
  type BoatSandboxType,
} from "../boat-rest-client";
import {
  buildSandboxEnvVars,
  DEFERRED_START_ENV_VAR,
  deriveCodeServerPassword,
  deriveVncPassword,
  IMAGE_BUILD_MODE_ENV_VAR,
  scmCloneIdentity,
} from "../sandbox-env";
import { SANDBOX_RUNTIME_VERSION } from "../runtime-manifest";
import {
  createVncAccess,
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  SandboxProviderError,
  signalUntilDeadline,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type ResumeConfig,
  type ResumeResult,
  type SandboxLifetime,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type StopConfig,
  type StopResult,
} from "../provider";
import { resolveSandboxPortPlan, type SandboxPortPlan } from "./port-resolution";

const log = createLogger("boat-provider");

const BOAT_MAX_TIMEOUT_SECONDS = 30 * 24 * 60 * 60;
const BOAT_CREATE_RECONCILIATION_MS = 180_000;
const BOAT_STATE_POLL_INTERVAL_MS = 1_000;
const BOAT_STARTUP_POLL_MS = 180_000;
const BOAT_STOP_POLL_MS = 120_000;
const BOAT_ENTRYPOINT_COMMAND = "/home/user/openinspect/start-runtime";
const BOAT_TUNNEL_ENV_PATH = "/home/user/openinspect/workspace/.tunnels.env";
const TUNNEL_ENV_SANDBOX_ID_KEY = "TUNNEL_SANDBOX_ID";
const EXPECTED_TUNNEL_PORTS_ENV_VAR = "EXPECTED_TUNNEL_PORTS";

const BOAT_MACHINE_RESOURCES = {
  small: { cpu: 2, memoryMib: 4096 },
  default: { cpu: 4, memoryMib: 8192 },
  large: { cpu: 8, memoryMib: 16384 },
} as const satisfies Record<BoatSandboxType, { cpu: number; memoryMib: number }>;

const READY_STATES = new Set(["ready", "idle"]);
const ACTIVE_STATES = new Set(["ready", "idle", "running"]);
const STOPPED_STATES = new Set(["stopped", "archived"]);
const STARTING_STATES = new Set(["init", "provisioning", "provisioned", "cloning", "resuming"]);
export interface BoatProviderConfig {
  scmProvider: SourceControlProviderName;
  sandboxAccessPasswordSecret: string;
  defaultType: BoatSandboxType;
  deploymentName: string;
}

export function resolveBoatSandboxType(
  defaultType: BoatSandboxType,
  settings: CreateSandboxConfig["sandboxSettings"]
): BoatSandboxType {
  const cpu = settings?.cpuCores ?? undefined;
  const memoryMib = settings?.memoryMib ?? undefined;
  if (cpu === undefined && memoryMib === undefined) return defaultType;

  for (const type of ["small", "default", "large"] as const) {
    const resources = BOAT_MACHINE_RESOURCES[type];
    if (
      (cpu === undefined || cpu <= resources.cpu) &&
      (memoryMib === undefined || memoryMib <= resources.memoryMib)
    ) {
      return type;
    }
  }
  throw new SandboxProviderError(
    "Boat resource request exceeds the largest supported machine (8 CPU, 16384 MiB)",
    "permanent"
  );
}

export function validateBoatEnvironment(env: Record<string, string>): void {
  const entries = Object.entries(env);
  if (entries.length > 100) {
    throw new SandboxProviderError(
      `Boat sandbox environment has ${entries.length} variables; maximum is 100`,
      "permanent"
    );
  }
  let bytes = 0;
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) {
      throw new SandboxProviderError(
        `Boat sandbox environment contains an invalid key: ${key}`,
        "permanent"
      );
    }
    bytes += new TextEncoder().encode(`${key}=${value}\n`).byteLength;
  }
  if (bytes > 64 * 1024) {
    throw new SandboxProviderError(
      `Boat sandbox environment is ${bytes} bytes; maximum is 65536`,
      "permanent"
    );
  }
}

export class BoatSandboxProvider implements SandboxProvider {
  readonly name = "boat";
  readonly capabilities: SandboxProviderCapabilities = {
    supportsSandboxTimeout: supportsConfigurableSandboxTimeout(this.name),
    supportsSnapshots: false,
    supportsRestore: false,
    supportsPersistentResume: true,
    supportsExplicitStop: true,
  };

  constructor(
    private readonly client: BoatRestClient,
    private readonly providerConfig: BoatProviderConfig
  ) {}

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    let providerObjectId: string | undefined;
    try {
      if (config.prebuiltImageId) {
        throw new SandboxProviderError(
          "Boat does not support repository or environment prebuilt images",
          "permanent"
        );
      }
      const timeoutSeconds = resolveBoatTimeoutSeconds(config.timeoutSeconds);
      const type = resolveBoatSandboxType(this.providerConfig.defaultType, config.sandboxSettings);
      const portPlan = resolveSandboxPortPlan(
        {
          codeServer: config.codeServerEnabled === true,
          terminal: config.sandboxSettings?.terminalEnabled === true,
          vnc: config.vncEnabled === true,
        },
        config.sandboxSettings
      );
      const { env, codeServerPassword, vncPassword } = await this.buildRuntimeEnvironment(
        config,
        timeoutSeconds,
        portPlan
      );
      validateBoatEnvironment(env);

      const created = await this.createWithReconciliation({
        type,
        ttlSeconds: timeoutSeconds,
        env,
        from: this.client.requireBaseSnapshot(),
        idempotencyKey: await boatCreateIdempotencyKey(
          this.providerConfig.deploymentName,
          config.sandboxId
        ),
      });
      providerObjectId = created.id;
      const ready = await this.waitForState(
        created.id,
        (sandbox) => READY_STATES.has(sandbox.state),
        BOAT_STARTUP_POLL_MS
      );
      const access = await this.prepareAccess(
        ready.id,
        config.sandboxId,
        portPlan,
        codeServerPassword,
        vncPassword
      );
      await this.startRuntime(ready.id);

      return {
        sandboxId: config.sandboxId,
        providerObjectId: ready.id,
        createdAt: parseTimestamp(ready.createdAt) ?? Date.now(),
        lifetime: lifetimeFromSandbox(ready, "create"),
        ...access,
      };
    } catch (error) {
      if (providerObjectId) await this.cleanupCreatedSandbox(providerObjectId);
      if (error instanceof SandboxProviderError) throw error;
      throw classifyBoatError("Failed to create Boat sandbox", error);
    }
  }

  async resumeSandbox(config: ResumeConfig): Promise<ResumeResult> {
    try {
      const timeoutSeconds = resolveBoatTimeoutSeconds(config.timeoutSeconds);
      const type = resolveBoatSandboxType(this.providerConfig.defaultType, config.sandboxSettings);
      let sandbox: BoatSandbox;
      try {
        sandbox = await this.client.getSandbox(config.providerObjectId);
      } catch (error) {
        if (error instanceof BoatNotFoundError) {
          return {
            success: false,
            error: "Sandbox no longer exists in Boat",
            shouldSpawnFresh: true,
          };
        }
        throw error;
      }

      if (STOPPED_STATES.has(sandbox.state)) {
        try {
          await this.client.resumeSandbox(config.providerObjectId, {
            type,
            ttlSeconds: timeoutSeconds,
          });
        } catch (error) {
          if (!(error instanceof BoatConflictError)) throw error;
        }
      } else if (!ACTIVE_STATES.has(sandbox.state) && !STARTING_STATES.has(sandbox.state)) {
        return {
          success: false,
          error: `Boat sandbox is in non-resumable state: ${sandbox.state}`,
        };
      }

      const ready = await this.waitForState(
        config.providerObjectId,
        (current) => READY_STATES.has(current.state),
        BOAT_STARTUP_POLL_MS
      );
      const portPlan = resolveSandboxPortPlan(
        {
          codeServer: config.codeServerEnabled === true,
          terminal: config.sandboxSettings?.terminalEnabled === true,
          vnc: config.vncEnabled === true,
        },
        config.sandboxSettings
      );
      const codeServerPassword = config.codeServerEnabled
        ? await deriveCodeServerPassword(
            config.sandboxId,
            this.providerConfig.sandboxAccessPasswordSecret
          )
        : undefined;
      const vncPassword = config.vncEnabled
        ? await deriveVncPassword(config.sandboxId, this.providerConfig.sandboxAccessPasswordSecret)
        : undefined;
      const access = await this.prepareAccess(
        ready.id,
        config.sandboxId,
        portPlan,
        codeServerPassword,
        vncPassword
      );
      await this.startRuntime(ready.id);

      const observed = await this.client.getSandbox(ready.id).catch(() => ready);
      return {
        success: true,
        providerObjectId: ready.id,
        lifetime: lifetimeFromSandbox(observed, "resume"),
        ...access,
      };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw classifyBoatError("Failed to resume Boat sandbox", error);
    }
  }

  async stopSandbox(config: StopConfig): Promise<StopResult> {
    const signal = signalUntilDeadline(config.deadlineAtMs, config.signal);
    try {
      if (config.intent === "destroy") {
        await this.destroySandbox(config.providerObjectId, signal);
        return { success: true };
      }

      let current: BoatSandbox;
      try {
        current = await this.client.getSandbox(config.providerObjectId, signal);
      } catch (error) {
        if (error instanceof BoatNotFoundError) {
          return {
            success: false,
            error: "Boat sandbox disappeared before preservation was verified",
          };
        }
        throw error;
      }
      if (!STOPPED_STATES.has(current.state)) {
        try {
          await this.client.stopSandbox(config.providerObjectId, signal);
        } catch (error) {
          if (!(error instanceof BoatConflictError)) throw error;
        }
      }
      const stopped = await this.waitForState(
        config.providerObjectId,
        (sandbox) => STOPPED_STATES.has(sandbox.state),
        BOAT_STOP_POLL_MS,
        signal
      );
      if (!stopped.snapshotAvailable) {
        return { success: false, error: "Boat stopped without a verified filesystem snapshot" };
      }
      return { success: true };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw classifyBoatError(
        `Failed to ${config.intent === "destroy" ? "delete" : "stop"} Boat sandbox`,
        error
      );
    }
  }

  private async buildRuntimeEnvironment(
    config: CreateSandboxConfig,
    timeoutSeconds: number,
    portPlan: SandboxPortPlan
  ): Promise<{ env: Record<string, string>; codeServerPassword?: string; vncPassword?: string }> {
    const codeServerPassword = config.codeServerEnabled
      ? await deriveCodeServerPassword(
          config.sandboxId,
          this.providerConfig.sandboxAccessPasswordSecret
        )
      : undefined;
    const vncPassword = config.vncEnabled
      ? await deriveVncPassword(config.sandboxId, this.providerConfig.sandboxAccessPasswordSecret)
      : undefined;
    const env = buildSandboxEnvVars(
      { ...config, timeoutSeconds },
      {
        scmIdentity: scmCloneIdentity(this.providerConfig.scmProvider),
        codeServerPassword,
        vncPassword,
        portPlan,
        emitDisabledTerminalEnv: true,
      }
    );
    Object.assign(env, {
      HOME: "/home/user",
      PYTHONPATH: "/app",
      NODE_PATH: "/usr/lib/node_modules",
      OI_SCM_CRED_CACHE_DIR: "/home/user/.cache/openinspect/scm",
      SANDBOX_VERSION: SANDBOX_RUNTIME_VERSION,
      [DEFERRED_START_ENV_VAR]: "false",
      [IMAGE_BUILD_MODE_ENV_VAR]: "false",
      RESTORED_FROM_SNAPSHOT: "false",
      FROM_REPO_IMAGE: "false",
      [EXPECTED_TUNNEL_PORTS_ENV_VAR]: portPlan.extraTunnelPorts.join(","),
    });
    return { env, codeServerPassword, vncPassword };
  }

  private async createWithReconciliation(
    params: Parameters<BoatRestClient["createSandbox"]>[0]
  ): Promise<BoatSandbox> {
    const deadline = Date.now() + BOAT_CREATE_RECONCILIATION_MS;
    for (;;) {
      try {
        return await this.client.createSandbox(params);
      } catch (error) {
        const retryable =
          (error instanceof BoatConflictError && error.code === "idempotency_in_progress") ||
          (error instanceof BoatApiError && (error.status === 429 || error.status >= 500)) ||
          SandboxProviderError.isTransientNetworkError(error);
        if (!retryable || Date.now() >= deadline) throw error;
        await delay(BOAT_STATE_POLL_INTERVAL_MS);
      }
    }
  }

  private async waitForState(
    id: string,
    accept: (sandbox: BoatSandbox) => boolean,
    timeoutMs: number,
    callerSignal?: AbortSignal
  ): Promise<BoatSandbox> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (callerSignal?.aborted) throw callerSignal.reason;
      const sandbox = await this.client.getSandbox(id, callerSignal);
      if (accept(sandbox)) return sandbox;
      if (sandbox.state === "error") {
        throw new SandboxProviderError("Boat sandbox entered the error state", "permanent");
      }
      if (Date.now() >= deadline) {
        throw new SandboxProviderError(`Boat sandbox remained ${sandbox.state}`, "transient");
      }
      await delay(BOAT_STATE_POLL_INTERVAL_MS, callerSignal);
    }
  }

  private async prepareAccess(
    providerObjectId: string,
    logicalSandboxId: string,
    portPlan: SandboxPortPlan,
    codeServerPassword?: string,
    vncPassword?: string
  ): Promise<{
    codeServerUrl?: string;
    codeServerPassword?: string;
    ttydUrl?: string;
    vncAccess?: ReturnType<typeof createVncAccess>;
    tunnelUrls?: Record<string, string>;
  }> {
    const requests = portPlan.allExposedPorts.map((port) => ({ port }));
    const hosted = await Promise.allSettled(
      requests.map(async ({ port }) => ({
        port,
        result: await this.client.hostPort(providerObjectId, port),
      }))
    );
    const urls = new Map<number, string>();
    for (const [index, result] of hosted.entries()) {
      if (result.status === "fulfilled") {
        urls.set(result.value.port, result.value.result.url);
      } else {
        log.warn("boat.host_port_failed", {
          sandbox_id: logicalSandboxId,
          port: requests[index]?.port,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }

    const tunnelUrls: Record<string, string> = {};
    for (const port of portPlan.extraTunnelPorts) {
      const url = urls.get(port);
      if (url) tunnelUrls[String(port)] = url;
    }
    if (Object.keys(tunnelUrls).length > 0) {
      const content = [
        `${TUNNEL_ENV_SANDBOX_ID_KEY}=${logicalSandboxId}`,
        ...Object.entries(tunnelUrls)
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([port, url]) => `TUNNEL_${port}=${url}`),
      ].join("\n");
      try {
        await this.client.writeTextFile(providerObjectId, BOAT_TUNNEL_ENV_PATH, `${content}\n`);
      } catch (error) {
        log.warn("boat.tunnel_env_write_failed", {
          sandbox_id: logicalSandboxId,
          ports: Object.keys(tunnelUrls),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const codeServerUrl = portPlan.codeServerPort ? urls.get(portPlan.codeServerPort) : undefined;
    const ttydUrl = portPlan.terminalPort ? urls.get(portPlan.terminalPort) : undefined;
    const vncUrl = portPlan.vncPort ? urls.get(portPlan.vncPort) : undefined;
    return {
      codeServerUrl,
      codeServerPassword: codeServerUrl ? codeServerPassword : undefined,
      ttydUrl,
      vncAccess: createVncAccess(vncUrl, vncPassword),
      tunnelUrls: Object.keys(tunnelUrls).length > 0 ? tunnelUrls : undefined,
    };
  }

  private async startRuntime(id: string): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const started = await this.client.startDetachedCommand(id, BOAT_ENTRYPOINT_COMMAND);
        const status = await this.client.getCommandStatus(id, started.processId);
        if (status.status === "lost" || (!status.running && status.exitCode !== 0)) {
          throw new SandboxProviderError(
            `Boat runtime launcher ${status.status} with exit code ${status.exitCode ?? "unknown"}`,
            "transient"
          );
        }
        return;
      } catch (error) {
        const retryable =
          (error instanceof BoatApiError && error.status >= 500) ||
          SandboxProviderError.isTransientNetworkError(error);
        if (!retryable || attempt === 3) throw error;
      }
    }
  }

  private async destroySandbox(id: string, signal?: AbortSignal): Promise<void> {
    let operationId: string | undefined;
    try {
      operationId = (await this.client.deleteSandbox(id, signal)).id;
    } catch (error) {
      if (error instanceof BoatNotFoundError) return;
      if (!(error instanceof BoatConflictError)) throw error;
    }
    // Boat removes the sandbox from normal reads immediately, while physical
    // deletion may remain blocked by shared named-snapshot data for hours.
    try {
      await this.client.getSandbox(id, signal);
    } catch (error) {
      if (error instanceof BoatNotFoundError) {
        if (operationId) await this.observeDeletion(operationId, signal);
        return;
      }
      throw error;
    }
    throw new SandboxProviderError(
      "Boat accepted deletion but the sandbox is still readable",
      "transient"
    );
  }

  private async observeDeletion(operationId: string, signal?: AbortSignal): Promise<void> {
    try {
      const operation = await this.client.getDeletionOperation(operationId, signal);
      log.info("boat.deletion_accepted", {
        operation_id: operation.id,
        operation_status: operation.status,
      });
    } catch (error) {
      log.warn("boat.deletion_observation_failed", {
        operation_id: operationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async cleanupCreatedSandbox(id: string): Promise<void> {
    try {
      await this.destroySandbox(id);
    } catch (error) {
      log.warn("boat.create_cleanup_failed", {
        provider_object_id: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function resolveBoatTimeoutSeconds(value: number | undefined): number {
  const timeoutSeconds = value ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS;
  if (
    !Number.isSafeInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > BOAT_MAX_TIMEOUT_SECONDS
  ) {
    throw new SandboxProviderError(
      `Boat sandbox timeout must be a whole number from 1 to ${BOAT_MAX_TIMEOUT_SECONDS} seconds`,
      "permanent"
    );
  }
  return timeoutSeconds;
}

async function boatCreateIdempotencyKey(
  deploymentName: string,
  sandboxId: string
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${deploymentName}:${sandboxId}`)
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
  return `openinspect:${hex}`;
}

function lifetimeFromSandbox(
  sandbox: BoatSandbox,
  operation: "create" | "resume"
): SandboxLifetime {
  const observedAtMs = Date.now();
  const expiresAtMs = parseTimestamp(sandbox.archiveAfter);
  if (expiresAtMs === null) {
    throw new SandboxProviderError(
      `Boat omitted a valid archiveAfter after ${operation}`,
      "transient"
    );
  }
  return { kind: "finite", expiresAtMs, observedAtMs, source: "provider" };
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function classifyBoatError(message: string, error: unknown): SandboxProviderError {
  if (error instanceof SandboxProviderError) return error;
  const transient =
    (error instanceof BoatApiError &&
      (error.status === 429 || error.status >= 500 || error.code === "idempotency_in_progress")) ||
    SandboxProviderError.isTransientNetworkError(error);
  return new SandboxProviderError(
    `${message}: ${error instanceof Error ? error.message : "unknown error"}`,
    transient ? "transient" : "permanent",
    error instanceof Error ? error : undefined
  );
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

export function createBoatProvider(
  client: BoatRestClient,
  providerConfig: BoatProviderConfig
): BoatSandboxProvider {
  return new BoatSandboxProvider(client, providerConfig);
}
