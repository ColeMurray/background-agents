/**
 * Vercel Sandbox provider implementation.
 */

import type { SandboxSettings } from "@open-inspect/shared/types/integrations";
import { resolveServicePorts, resolveTunnelPorts } from "../port-resolution";
import { createLogger } from "../../../logger";
import type { SourceControlProviderName } from "../../../source-control";
import {
  buildImageBuildCallbackEnv,
  buildImageBuildEnvVars,
  buildSandboxEnvVars,
  deriveCodeServerPassword,
  deriveVncPassword,
  IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_KEY,
  imageBuildSandboxIdentity,
  scmCloneIdentity,
} from "../../sandbox-env";
import {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  SandboxProviderError,
  createVncAccess,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type ImageBuildProviderTriggerConfig,
  type RestoreConfig,
  type RestoreResult,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type SnapshotConfig,
  type SnapshotResult,
  type StopConfig,
  type StopResult,
  type VncAccess,
} from "../../provider";
import type {
  VercelCommandResult,
  VercelCreateSandboxResponse,
  VercelSandboxClient,
  VercelSandboxRoute,
  VercelVcpus,
} from "./client";
import { VercelSandboxApiError } from "./client";
import { DEFAULT_VERCEL_RUNTIME, VERCEL_PYTHON_BIN, VERCEL_SANDBOX_VERSION } from "./bootstrap";

const log = createLogger("vercel-provider");

const TUNNEL_ENV_FILE_PATH = "/workspace/.tunnels.env";
// Mirrors TUNNEL_ENV_SANDBOX_ID_KEY in sandbox_runtime/constants.py: tags the
// tunnel env file with the sandbox it was written for, so the supervisor's
// stale-file cleanup keeps a fresh write instead of deleting it.
const TUNNEL_ENV_SANDBOX_ID_KEY = "TUNNEL_SANDBOX_ID";
const EXPECTED_TUNNEL_PORTS_ENV_VAR = "EXPECTED_TUNNEL_PORTS";
const DEFAULT_SNAPSHOT_EXPIRATION_MS = 0;
// Exported for the stale-threshold ceiling assertion in image-builds/maintenance.test.ts.
export const VERCEL_MAX_SANDBOX_TIMEOUT_MS = 45 * 60 * 1000;
const VERCEL_MEMORY_MIB_PER_VCPU = 2048;
const VERCEL_SUPPORTED_VCPUS: readonly VercelVcpus[] = [1, 2, 4, 8];
const VERCEL_MAX_VCPUS = VERCEL_SUPPORTED_VCPUS[VERCEL_SUPPORTED_VCPUS.length - 1];
const VERCEL_TUNNEL_ENV_WRITE_TIMEOUT_MS = 30_000;

function resolveVercelTimeoutMs(timeoutSeconds?: number): number {
  const requestedMs = (timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS) * 1000;
  return Math.min(requestedMs, VERCEL_MAX_SANDBOX_TIMEOUT_MS);
}

export interface VercelProviderConfig {
  scmProvider: SourceControlProviderName;
  baseSnapshotId?: string;
  baseSnapshotName?: string;
  runtime?: string;
  snapshotExpirationMs?: number;
  /** Secret used for domain-separated sandbox access password derivation. */
  sandboxAccessPasswordSecret: string;
  apiBaseUrl?: string;
  token: string;
  teamId?: string;
}

export class VercelSandboxProvider implements SandboxProvider {
  readonly name = "vercel";
  private baseSnapshotIdPromise?: Promise<string>;

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSandboxTimeout: true,
    supportsSnapshots: true,
    supportsRestore: true,
    supportsPersistentResume: false,
    supportsExplicitStop: true,
  };

  constructor(
    private readonly client: VercelSandboxClient,
    private readonly providerConfig: VercelProviderConfig
  ) {}

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    try {
      const timeoutMs = resolveVercelTimeoutMs(config.timeoutSeconds);
      const env = await this.buildEnvVars(
        { ...config, timeoutSeconds: timeoutMs / 1000 },
        {
          fromPrebuiltImage: !!config.prebuiltImageId,
          prebuiltImageSha: config.prebuiltImageSha ?? undefined,
        }
      );
      const ports = collectExposedPorts(
        config.codeServerEnabled,
        config.vncEnabled,
        config.sandboxSettings
      ).allExposedPorts;
      const sourceSnapshotId =
        config.prebuiltImageId || (await this.resolveBaseSnapshotId(config.correlation));
      if (!sourceSnapshotId) {
        throw new Error(
          "VERCEL_BASE_SNAPSHOT_ID or VERCEL_BASE_SNAPSHOT_NAME is required for fresh Vercel sandboxes when no repo image snapshot is available"
        );
      }

      const created = await this.client.createSandbox(
        {
          name: config.sandboxId,
          runtime: this.providerConfig.runtime || DEFAULT_VERCEL_RUNTIME,
          timeoutMs,
          resources: resolveVercelResources(config.sandboxSettings),
          ports,
          env,
          tags: this.buildTags(config),
          sourceSnapshotId,
        },
        config.correlation
      );

      const access = await this.prepareSandboxAccess(
        created,
        config.sandboxId,
        config.codeServerEnabled,
        config.vncEnabled,
        config.sandboxSettings,
        config.correlation
      );

      await this.launchEntrypoint(created.session.id, {}, config.correlation);

      return {
        sandboxId: config.sandboxId,
        providerObjectId: created.session.id,
        status: "warming",
        createdAt: created.session.createdAt || Date.now(),
        codeServerUrl: access.codeServerUrl,
        codeServerPassword: access.codeServerPassword,
        ttydUrl: access.ttydUrl,
        vncAccess: access.vncAccess,
        tunnelUrls: access.tunnelUrls,
      };
    } catch (error) {
      throw this.classifyError("Failed to create Vercel sandbox", error);
    }
  }

  async restoreFromSnapshot(config: RestoreConfig): Promise<RestoreResult> {
    try {
      const timeoutMs = resolveVercelTimeoutMs(config.timeoutSeconds);
      const env = await this.buildEnvVars(
        { ...config, timeoutSeconds: timeoutMs / 1000 },
        { restoredFromSnapshot: true }
      );
      const ports = collectExposedPorts(
        config.codeServerEnabled,
        config.vncEnabled,
        config.sandboxSettings
      ).allExposedPorts;

      const created = await this.client.createSandbox(
        {
          name: config.sandboxId,
          runtime: this.providerConfig.runtime || DEFAULT_VERCEL_RUNTIME,
          timeoutMs,
          resources: resolveVercelResources(config.sandboxSettings),
          ports,
          env,
          tags: this.buildTags(config),
          sourceSnapshotId: config.snapshotImageId,
        },
        config.correlation
      );

      const access = await this.prepareSandboxAccess(
        created,
        config.sandboxId,
        config.codeServerEnabled,
        config.vncEnabled,
        config.sandboxSettings,
        config.correlation
      );

      await this.launchEntrypoint(created.session.id, {}, config.correlation);

      return {
        success: true,
        sandboxId: config.sandboxId,
        providerObjectId: created.session.id,
        codeServerUrl: access.codeServerUrl,
        codeServerPassword: access.codeServerPassword,
        ttydUrl: access.ttydUrl,
        vncAccess: access.vncAccess,
        tunnelUrls: access.tunnelUrls,
      };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to restore Vercel sandbox from snapshot", error);
    }
  }

  async takeSnapshot(config: SnapshotConfig): Promise<SnapshotResult> {
    try {
      const snapshot = await this.client.snapshotSession(
        config.providerObjectId,
        {
          expirationMs: this.providerConfig.snapshotExpirationMs ?? DEFAULT_SNAPSHOT_EXPIRATION_MS,
          signal: config.signal,
        },
        config.correlation
      );

      if (snapshot.snapshot.status !== "created") {
        return {
          success: false,
          error: `Snapshot status was ${snapshot.snapshot.status}`,
        };
      }

      return { success: true, imageId: snapshot.snapshot.id };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to snapshot Vercel sandbox", error);
    }
  }

  async stopSandbox(config: StopConfig): Promise<StopResult> {
    try {
      await this.client.stopSession(
        config.providerObjectId,
        config.correlation,
        ...(config.signal ? [config.signal] : [])
      );
      return { success: true };
    } catch (error) {
      if (error instanceof VercelSandboxApiError && error.status === 404) {
        return { success: true };
      }
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to stop Vercel sandbox", error);
    }
  }

  /**
   * Trigger a Vercel environment-image build (design §7.3). The
   * SESSION_CONFIG carries the repository list so the list-native runtime
   * clones and sets up every repository.
   */
  async triggerImageBuild(config: ImageBuildProviderTriggerConfig): Promise<void> {
    try {
      const baseSnapshotId = await this.resolveBaseSnapshotId(config.correlation);
      if (!baseSnapshotId) {
        throw new Error(
          "VERCEL_BASE_SNAPSHOT_ID or VERCEL_BASE_SNAPSHOT_NAME is required to build Vercel environment image snapshots"
        );
      }

      const identity = imageBuildSandboxIdentity(config, Date.now());
      const env = this.buildBuildEnvVars(config, identity.sandboxId);
      const created = await this.client.createSandbox(
        {
          name: identity.sandboxName,
          runtime: this.providerConfig.runtime || DEFAULT_VERCEL_RUNTIME,
          timeoutMs: resolveVercelTimeoutMs(config.providerSessionTimeoutSeconds),
          env,
          tags: identity.labels,
          sourceSnapshotId: baseSnapshotId,
        },
        config.correlation
      );

      await config.onProviderSessionCreated(created.session.id);

      const command = await this.launchEntrypoint(
        created.session.id,
        this.buildImageCallbackEnv(config, created.session.id),
        config.correlation
      );

      // Spread correlation first so the explicit fields (notably session_id,
      // the new provider session) win over correlation's.
      log.info("vercel.environment_image_build_triggered", {
        ...config.correlation,
        build_id: config.buildId,
        scope_kind: config.scopeKind,
        scope_id: config.scopeId,
        session_id: created.session.id,
        command_id: command.commandId,
        sandbox_name: identity.sandboxName,
      });
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to trigger Vercel environment image build", error);
    }
  }

  async deleteProviderImage(providerImageId: string, signal?: AbortSignal): Promise<void> {
    try {
      if (signal) {
        await this.client.deleteSnapshot(providerImageId, undefined, signal);
      } else {
        await this.client.deleteSnapshot(providerImageId);
      }
    } catch (error) {
      if (error instanceof VercelSandboxApiError && error.status === 404) return;
      throw this.classifyError("Failed to delete Vercel snapshot", error);
    }
  }

  private async buildEnvVars(
    config: CreateSandboxConfig | RestoreConfig,
    mode: {
      restoredFromSnapshot?: boolean;
      fromPrebuiltImage?: boolean;
      prebuiltImageSha?: string;
    }
  ): Promise<Record<string, string>> {
    const envVars = buildSandboxEnvVars(config, {
      scmIdentity: scmCloneIdentity(this.providerConfig.scmProvider),
      codeServerPassword: config.codeServerEnabled
        ? await deriveCodeServerPassword(
            config.sandboxId,
            this.providerConfig.sandboxAccessPasswordSecret
          )
        : undefined,
      vncPassword: config.vncEnabled
        ? await deriveVncPassword(config.sandboxId, this.providerConfig.sandboxAccessPasswordSecret)
        : undefined,
    });
    Object.assign(envVars, this.buildPlatformEnvVars());

    if (mode.restoredFromSnapshot) envVars.RESTORED_FROM_SNAPSHOT = "true";
    if (mode.fromPrebuiltImage) {
      envVars.FROM_REPO_IMAGE = "true";
      envVars.REPO_IMAGE_SHA = mode.prebuiltImageSha ?? "";
    }
    if (config.sandboxSettings?.terminalEnabled) {
      envVars.TERMINAL_ENABLED = "true";
      envVars.TTYD_PROXY_PORT = String(resolveServicePorts(config.sandboxSettings).terminalPort);
    }

    const tunnelPorts = collectExposedPorts(
      config.codeServerEnabled,
      config.vncEnabled,
      config.sandboxSettings
    ).extraTunnelPorts;
    if (tunnelPorts.length > 0) {
      envVars[EXPECTED_TUNNEL_PORTS_ENV_VAR] = tunnelPorts.join(",");
    }

    return envVars;
  }

  /** Shared build-sandbox env assembly plus Vercel's platform overlay. */
  private buildBuildEnvVars(
    config: ImageBuildProviderTriggerConfig,
    sandboxId: string
  ): Record<string, string> {
    const envVars = buildImageBuildEnvVars({
      sandboxId,
      repositories: config.repositories,
      scmIdentity: scmCloneIdentity(this.providerConfig.scmProvider),
      cloneToken: config.cloneToken,
      baseEnvVars: config.userEnvVars,
    });
    // SANDBOX_VERSION comes from buildPlatformEnvVars now.
    Object.assign(envVars, this.buildPlatformEnvVars());
    return envVars;
  }

  /** Vercel base-image paths layered on top of the canonical sandbox env. */
  private buildPlatformEnvVars(): Record<string, string> {
    return {
      // The base snapshot bakes no SANDBOX_VERSION, so without this every
      // sandbox reports an unknown runtime and its snapshots are unrestorable.
      SANDBOX_VERSION: VERCEL_SANDBOX_VERSION,
      HOME: "/root",
      NODE_ENV: "development",
      PATH: buildVercelRuntimePath(this.providerConfig.runtime),
      PYTHONPATH: "/app",
      PYTHONUNBUFFERED: "1",
      NODE_PATH: "/usr/lib/node_modules:/usr/local/lib/node_modules",
    };
  }

  private buildTags(config: CreateSandboxConfig | RestoreConfig): Record<string, string> {
    return {
      openinspect_framework: "open-inspect",
      openinspect_session_id: config.sessionId,
      openinspect_expected_sandbox_id: config.sandboxId,
      ...(config.repoOwner && config.repoName
        ? { openinspect_repo: `${config.repoOwner}/${config.repoName}` }
        : {}),
    };
  }

  private async prepareSandboxAccess(
    created: VercelCreateSandboxResponse,
    logicalSandboxId: string,
    codeServerEnabled: boolean | undefined,
    vncEnabled: boolean | undefined,
    sandboxSettings: SandboxSettings | undefined,
    correlation?: CreateSandboxConfig["correlation"]
  ): Promise<{
    codeServerUrl?: string;
    codeServerPassword?: string;
    ttydUrl?: string;
    vncAccess?: VncAccess;
    tunnelUrls?: Record<string, string>;
  }> {
    const routeByPort = new Map(created.routes.map((route) => [route.port, route]));
    const { extraTunnelPorts } = collectExposedPorts(
      codeServerEnabled,
      vncEnabled,
      sandboxSettings
    );
    const tunnelUrls: Record<string, string> = {};

    for (const port of extraTunnelPorts) {
      const url = routeToUrl(routeByPort.get(port));
      if (url) tunnelUrls[String(port)] = url;
    }

    if (Object.keys(tunnelUrls).length > 0) {
      await this.writeTunnelEnvFile(created.session.id, logicalSandboxId, tunnelUrls, correlation);
    }

    const { codeServerPort, terminalPort, vncPort } = resolveServicePorts(sandboxSettings);
    const codeServerUrl = codeServerEnabled
      ? routeToUrl(routeByPort.get(codeServerPort))
      : undefined;
    const ttydUrl = sandboxSettings?.terminalEnabled
      ? routeToUrl(routeByPort.get(terminalPort))
      : undefined;
    const vncUrl = vncEnabled ? routeToUrl(routeByPort.get(vncPort)) : undefined;
    const vncPassword = vncEnabled
      ? await deriveVncPassword(logicalSandboxId, this.providerConfig.sandboxAccessPasswordSecret)
      : undefined;

    return {
      codeServerUrl,
      codeServerPassword: codeServerEnabled
        ? await deriveCodeServerPassword(
            logicalSandboxId,
            this.providerConfig.sandboxAccessPasswordSecret
          )
        : undefined,
      ttydUrl,
      vncAccess: createVncAccess(vncUrl, vncPassword),
      tunnelUrls: Object.keys(tunnelUrls).length > 0 ? tunnelUrls : undefined,
    };
  }

  private async writeTunnelEnvFile(
    sessionId: string,
    logicalSandboxId: string,
    tunnelUrls: Record<string, string>,
    correlation?: CreateSandboxConfig["correlation"]
  ): Promise<void> {
    const lines = [
      `${TUNNEL_ENV_SANDBOX_ID_KEY}=${logicalSandboxId}`,
      ...Object.entries(tunnelUrls)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([port, url]) => `TUNNEL_${port}=${url}`),
    ];
    const content = lines.join("\n") + "\n";

    const script = [
      "from pathlib import Path",
      `Path(${JSON.stringify(TUNNEL_ENV_FILE_PATH)}).write_text(${JSON.stringify(content)})`,
    ].join("\n");

    const result = await this.client.runCommandAndWait(
      {
        sessionId,
        command: "sudo",
        args: ["-E", VERCEL_PYTHON_BIN, "-c", script],
        timeoutMs: VERCEL_TUNNEL_ENV_WRITE_TIMEOUT_MS,
      },
      correlation
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to write Vercel tunnel env file (exit_code=${result.exitCode})`);
    }
  }

  private async resolveBaseSnapshotId(
    correlation?: CreateSandboxConfig["correlation"]
  ): Promise<string | undefined> {
    if (this.providerConfig.baseSnapshotId) {
      return this.providerConfig.baseSnapshotId;
    }

    const snapshotName = this.providerConfig.baseSnapshotName;
    if (!snapshotName) {
      return undefined;
    }

    this.baseSnapshotIdPromise ||= this.lookupBaseSnapshotIdByName(snapshotName, correlation);
    try {
      return await this.baseSnapshotIdPromise;
    } catch (error) {
      this.baseSnapshotIdPromise = undefined;
      throw error;
    }
  }

  private async lookupBaseSnapshotIdByName(
    snapshotName: string,
    correlation?: CreateSandboxConfig["correlation"]
  ): Promise<string> {
    const snapshots = await this.client.listSnapshots(
      {
        name: snapshotName,
        limit: 20,
        sortOrder: "desc",
      },
      correlation
    );
    const snapshot = snapshots.find((candidate) => candidate.status === "created");
    if (!snapshot) {
      throw new Error(`No created Vercel base snapshot found for sandbox name ${snapshotName}`);
    }

    log.info("vercel.base_snapshot_resolved", {
      snapshot_name: snapshotName,
      snapshot_id: snapshot.id,
      created_at: snapshot.createdAt,
    });
    return snapshot.id;
  }

  private async launchEntrypoint(
    sessionId: string,
    env: Record<string, string>,
    correlation?: CreateSandboxConfig["correlation"]
  ): Promise<VercelCommandResult> {
    return this.client.startCommand(
      {
        sessionId,
        command: "sudo",
        args: ["-E", VERCEL_PYTHON_BIN, "-m", "sandbox_runtime.entrypoint"],
        cwd: "/workspace",
        env,
      },
      correlation
    );
  }

  private buildImageCallbackEnv(
    config: {
      buildId: string;
      callbackUrl: string;
      failureCallbackUrl: string;
      callbackToken: string;
      buildExecutionTimeoutSeconds: number;
    },
    sessionId: string
  ): Record<string, string> {
    return {
      ...buildImageBuildCallbackEnv({
        buildId: config.buildId,
        callbackUrl: config.callbackUrl,
        failureCallbackUrl: config.failureCallbackUrl,
        token: config.callbackToken,
        providerSessionId: sessionId,
      }),
      [IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_KEY]: String(config.buildExecutionTimeoutSeconds),
    };
  }

  private classifyError(message: string, error: unknown): SandboxProviderError {
    if (error instanceof VercelSandboxApiError) {
      return SandboxProviderError.fromFetchError(
        `${message}: ${error.message}`,
        error,
        error.status
      );
    }
    return SandboxProviderError.fromFetchError(
      `${message}: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  }
}

function collectExposedPorts(
  codeServerEnabled: boolean | undefined,
  vncEnabled: boolean | undefined,
  sandboxSettings: SandboxSettings | undefined
): { allExposedPorts: number[]; extraTunnelPorts: number[] } {
  const { codeServerPort, terminalPort, vncPort } = resolveServicePorts(sandboxSettings);
  const reserved = new Set<number>();
  const exposed: number[] = [];

  if (codeServerEnabled) {
    exposed.push(codeServerPort);
    reserved.add(codeServerPort);
  }
  if (sandboxSettings?.terminalEnabled) {
    exposed.push(terminalPort);
    reserved.add(terminalPort);
  }
  if (vncEnabled) {
    exposed.push(vncPort);
    reserved.add(vncPort);
  }

  const extraTunnelPorts = resolveTunnelPorts(sandboxSettings?.tunnelPorts).filter(
    (port) => !reserved.has(port)
  );
  exposed.push(...extraTunnelPorts);

  return { allExposedPorts: exposed, extraTunnelPorts };
}

function resolveVercelResources(
  sandboxSettings: SandboxSettings | undefined
): { vcpus: VercelVcpus } | undefined {
  const requestedCpuCores = sandboxSettings?.cpuCores ?? undefined;
  const requestedMemoryMib = sandboxSettings?.memoryMib ?? undefined;
  const vcpusForMemory =
    requestedMemoryMib === undefined
      ? undefined
      : Math.ceil(requestedMemoryMib / VERCEL_MEMORY_MIB_PER_VCPU);
  const requestedVcpus = Math.max(requestedCpuCores ?? 0, vcpusForMemory ?? 0);

  if (requestedVcpus <= 0) return undefined;
  const supportedVcpus = VERCEL_SUPPORTED_VCPUS.find((vcpus) => vcpus >= requestedVcpus);
  if (supportedVcpus === undefined) {
    throw new SandboxProviderError(
      `Vercel sandbox resources support up to ${VERCEL_MAX_VCPUS} vCPUs; requested ${requestedVcpus}`,
      "permanent"
    );
  }
  return { vcpus: supportedVcpus };
}

function routeToUrl(route: VercelSandboxRoute | undefined): string | undefined {
  if (!route) return undefined;
  if (route.url) return route.url.startsWith("http") ? route.url : `https://${route.url}`;
  return `https://${route.subdomain}.vercel.run`;
}

function buildVercelRuntimePath(runtime?: string): string {
  const resolvedRuntime = runtime || DEFAULT_VERCEL_RUNTIME;
  return `/root/.bun/bin:/usr/local/bin:/usr/bin:/bin:/vercel/runtimes/${resolvedRuntime}/bin`;
}

export function createVercelProvider(
  client: VercelSandboxClient,
  providerConfig: VercelProviderConfig
): VercelSandboxProvider {
  return new VercelSandboxProvider(client, providerConfig);
}
