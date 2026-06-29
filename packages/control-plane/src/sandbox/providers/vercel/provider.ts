/**
 * Vercel Sandbox provider implementation.
 */

import {
  computeHmacHex,
  DEFAULT_BUILD_TIMEOUT_SECONDS,
  type SandboxSettings,
} from "@open-inspect/shared";
import { resolveServicePorts, resolveTunnelPorts } from "../port-resolution";
import { createLogger } from "../../../logger";
import type { CorrelationContext } from "../../../logger";
import type { SourceControlProviderName } from "../../../source-control";
import { buildSessionConfig } from "../../sandbox-env";
import {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  SandboxProviderError,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type RestoreConfig,
  type RestoreResult,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type SnapshotConfig,
  type SnapshotResult,
  type StopConfig,
  type StopResult,
} from "../../provider";
import type {
  VercelCommandResult,
  VercelCreateSandboxResponse,
  VercelSandboxClient,
  VercelSandboxRoute,
  VercelVcpus,
} from "./client";
import { VercelSandboxApiError } from "./client";
import { DEFAULT_VERCEL_RUNTIME, VERCEL_PYTHON_BIN } from "./bootstrap";

const log = createLogger("vercel-provider");

const TUNNEL_ENV_FILE_PATH = "/workspace/.tunnels.env";
const EXPECTED_TUNNEL_PORTS_ENV_VAR = "EXPECTED_TUNNEL_PORTS";
const DEFAULT_SNAPSHOT_EXPIRATION_MS = 0;
const VERCEL_MAX_SANDBOX_TIMEOUT_MS = 45 * 60 * 1000;
const VERCEL_MEMORY_MIB_PER_VCPU = 2048;
const VERCEL_SUPPORTED_VCPUS: readonly VercelVcpus[] = [1, 2, 4, 8];
const VERCEL_MAX_VCPUS = VERCEL_SUPPORTED_VCPUS[VERCEL_SUPPORTED_VCPUS.length - 1];
const VERCEL_TUNNEL_ENV_WRITE_TIMEOUT_MS = 30_000;
const REPO_IMAGE_CALLBACK_ENV_KEYS = [
  "OI_REPO_IMAGE_PROVIDER_SESSION_ID",
  "OI_REPO_IMAGE_BUILD_ID",
  "OI_REPO_IMAGE_CALLBACK_URL",
  "OI_REPO_IMAGE_CALLBACK_TOKEN",
] as const;
const RESERVED_REPO_IMAGE_CALLBACK_ENV_KEYS = [
  ...REPO_IMAGE_CALLBACK_ENV_KEYS,
  "OI_REPO_IMAGE_CALLBACK_SECRET",
] as const;

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
  codeServerPasswordSecret: string;
  apiBaseUrl?: string;
  token: string;
  teamId?: string;
}

export interface TriggerVercelRepoImageBuildConfig {
  buildId: string;
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
  callbackUrl: string;
  callbackToken: string;
  userEnvVars?: Record<string, string>;
  cloneToken?: string;
  /**
   * Build sandbox lifetime, in seconds (already capped at
   * MAX_BUILD_TIMEOUT_SECONDS by the trigger). Further capped to Vercel's own
   * limit. Omitted → DEFAULT_BUILD_TIMEOUT_SECONDS.
   */
  buildTimeoutSeconds?: number;
  onProviderSessionCreated?: (providerSessionId: string) => Promise<void>;
  correlation?: CorrelationContext;
}

export interface TriggerVercelRepoImageBuildResult {
  buildId: string;
  status: string;
}

export class VercelSandboxProvider implements SandboxProvider {
  readonly name = "vercel";
  private baseSnapshotIdPromise?: Promise<string>;

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSnapshots: true,
    supportsRestore: true,
    supportsWarm: true,
    supportsPersistentResume: false,
    supportsExplicitStop: true,
  };

  constructor(
    private readonly client: VercelSandboxClient,
    private readonly providerConfig: VercelProviderConfig
  ) {}

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    try {
      const env = await this.buildEnvVars(config, {
        fromRepoImage: !!config.repoImageId,
        repoImageSha: config.repoImageSha ?? undefined,
      });
      const ports = collectExposedPorts(
        config.codeServerEnabled,
        config.sandboxSettings
      ).allExposedPorts;
      const sourceSnapshotId =
        config.repoImageId || (await this.resolveBaseSnapshotId(config.correlation));
      if (!sourceSnapshotId) {
        throw new Error(
          "VERCEL_BASE_SNAPSHOT_ID or VERCEL_BASE_SNAPSHOT_NAME is required for fresh Vercel sandboxes when no repo image snapshot is available"
        );
      }

      const created = await this.client.createSandbox(
        {
          name: config.sandboxId,
          runtime: this.providerConfig.runtime || DEFAULT_VERCEL_RUNTIME,
          timeoutMs: resolveVercelTimeoutMs(config.timeoutSeconds),
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
        tunnelUrls: access.tunnelUrls,
      };
    } catch (error) {
      throw this.classifyError("Failed to create Vercel sandbox", error);
    }
  }

  async restoreFromSnapshot(config: RestoreConfig): Promise<RestoreResult> {
    try {
      const env = await this.buildEnvVars(config, { restoredFromSnapshot: true });
      const ports = collectExposedPorts(
        config.codeServerEnabled,
        config.sandboxSettings
      ).allExposedPorts;

      const created = await this.client.createSandbox(
        {
          name: config.sandboxId,
          runtime: this.providerConfig.runtime || DEFAULT_VERCEL_RUNTIME,
          timeoutMs: resolveVercelTimeoutMs(config.timeoutSeconds),
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
      await this.client.stopSession(config.providerObjectId, config.correlation);
      return { success: true };
    } catch (error) {
      if (error instanceof VercelSandboxApiError && error.status === 404) {
        return { success: true };
      }
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to stop Vercel sandbox", error);
    }
  }

  async triggerRepoImageBuild(
    config: TriggerVercelRepoImageBuildConfig
  ): Promise<TriggerVercelRepoImageBuildResult> {
    try {
      const baseSnapshotId = await this.resolveBaseSnapshotId(config.correlation);
      if (!baseSnapshotId) {
        throw new Error(
          "VERCEL_BASE_SNAPSHOT_ID or VERCEL_BASE_SNAPSHOT_NAME is required to build Vercel repo image snapshots"
        );
      }

      const sandboxName = `build-${config.repoOwner}-${config.repoName}-${Date.now()}`;
      const env = await this.buildBuildEnvVars(config);
      const created = await this.client.createSandbox(
        {
          name: sandboxName,
          runtime: this.providerConfig.runtime || DEFAULT_VERCEL_RUNTIME,
          timeoutMs: resolveVercelTimeoutMs(
            config.buildTimeoutSeconds ?? DEFAULT_BUILD_TIMEOUT_SECONDS
          ),
          env,
          tags: {
            openinspect_framework: "open-inspect",
            openinspect_kind: "repo-image-build",
            openinspect_build_id: config.buildId,
            openinspect_repo: `${config.repoOwner}/${config.repoName}`,
          },
          sourceSnapshotId: baseSnapshotId,
        },
        config.correlation
      );

      if (config.onProviderSessionCreated) {
        await config.onProviderSessionCreated(created.session.id);
      }

      const command = await this.launchEntrypoint(
        created.session.id,
        this.buildRepoImageCallbackEnv(config, created.session.id),
        config.correlation
      );

      log.info("vercel.repo_image_build_triggered", {
        build_id: config.buildId,
        repo_owner: config.repoOwner,
        repo_name: config.repoName,
        session_id: created.session.id,
        command_id: command.commandId,
        sandbox_name: sandboxName,
      });

      return { buildId: config.buildId, status: "building" };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to trigger Vercel repo image build", error);
    }
  }

  async deleteProviderImage(providerImageId: string): Promise<void> {
    try {
      await this.client.deleteSnapshot(providerImageId);
    } catch (error) {
      throw this.classifyError("Failed to delete Vercel snapshot", error);
    }
  }

  private async buildEnvVars(
    config: CreateSandboxConfig | RestoreConfig,
    mode: {
      restoredFromSnapshot?: boolean;
      fromRepoImage?: boolean;
      repoImageSha?: string;
    }
  ): Promise<Record<string, string>> {
    const envVars: Record<string, string> = { ...(config.userEnvVars ?? {}) };
    const sessionConfig = buildSessionConfig(config);

    Object.assign(envVars, {
      HOME: "/root",
      NODE_ENV: "development",
      PATH: buildVercelRuntimePath(this.providerConfig.runtime),
      PYTHONPATH: "/app",
      PYTHONUNBUFFERED: "1",
      NODE_PATH: "/usr/lib/node_modules:/usr/local/lib/node_modules",
      SANDBOX_ID: config.sandboxId,
      CONTROL_PLANE_URL: config.controlPlaneUrl,
      SANDBOX_AUTH_TOKEN: config.sandboxAuthToken,
      REPO_OWNER: config.repoOwner ?? "",
      REPO_NAME: config.repoName ?? "",
      SESSION_CONFIG: JSON.stringify(sessionConfig),
    });

    this.injectScmEnvVars(envVars);

    if (mode.restoredFromSnapshot) envVars.RESTORED_FROM_SNAPSHOT = "true";
    if (mode.fromRepoImage) {
      envVars.FROM_REPO_IMAGE = "true";
      envVars.REPO_IMAGE_SHA = mode.repoImageSha ?? "";
    }
    const { codeServerPort, terminalPort } = resolveServicePorts(config.sandboxSettings);
    if (config.codeServerEnabled) {
      envVars.CODE_SERVER_PASSWORD = await this.deriveCodeServerPassword(config.sandboxId);
      envVars.CODE_SERVER_PORT = String(codeServerPort);
    }
    if (config.sandboxSettings?.terminalEnabled) {
      envVars.TERMINAL_ENABLED = "true";
      envVars.TTYD_PROXY_PORT = String(terminalPort);
    }
    if (config.agentSlackNotifyEnabled) {
      envVars.AGENT_SLACK_NOTIFY_ENABLED = "true";
    }

    const tunnelPorts = collectExposedPorts(
      config.codeServerEnabled,
      config.sandboxSettings
    ).extraTunnelPorts;
    if (tunnelPorts.length > 0) {
      envVars[EXPECTED_TUNNEL_PORTS_ENV_VAR] = tunnelPorts.join(",");
    }

    return envVars;
  }

  private async buildBuildEnvVars(
    config: TriggerVercelRepoImageBuildConfig
  ): Promise<Record<string, string>> {
    const envVars: Record<string, string> = { ...(config.userEnvVars ?? {}) };
    for (const key of RESERVED_REPO_IMAGE_CALLBACK_ENV_KEYS) {
      delete envVars[key];
    }

    Object.assign(envVars, {
      HOME: "/root",
      NODE_ENV: "development",
      PATH: buildVercelRuntimePath(this.providerConfig.runtime),
      PYTHONPATH: "/app",
      PYTHONUNBUFFERED: "1",
      NODE_PATH: "/usr/lib/node_modules:/usr/local/lib/node_modules",
      SANDBOX_ID: `build-${config.repoOwner}-${config.repoName}`,
      REPO_OWNER: config.repoOwner,
      REPO_NAME: config.repoName,
      IMAGE_BUILD_MODE: "true",
      SESSION_CONFIG: JSON.stringify({ branch: config.defaultBranch }),
    });

    this.injectScmEnvVars(envVars, config.cloneToken);
    return envVars;
  }

  private injectScmEnvVars(envVars: Record<string, string>, cloneToken?: string): void {
    if (this.providerConfig.scmProvider === "gitlab") {
      envVars.VCS_HOST = "gitlab.com";
      envVars.VCS_CLONE_USERNAME = "oauth2";
    } else if (this.providerConfig.scmProvider === "bitbucket") {
      envVars.VCS_HOST = "bitbucket.org";
      envVars.VCS_CLONE_USERNAME = "x-token-auth";
    } else {
      envVars.VCS_HOST = "github.com";
      envVars.VCS_CLONE_USERNAME = "x-access-token";
    }

    if (cloneToken) {
      envVars.VCS_CLONE_TOKEN = cloneToken;
    }
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
    sandboxSettings: SandboxSettings | undefined,
    correlation?: CreateSandboxConfig["correlation"]
  ): Promise<{
    codeServerUrl?: string;
    codeServerPassword?: string;
    ttydUrl?: string;
    tunnelUrls?: Record<string, string>;
  }> {
    const routeByPort = new Map(created.routes.map((route) => [route.port, route]));
    const { extraTunnelPorts } = collectExposedPorts(codeServerEnabled, sandboxSettings);
    const tunnelUrls: Record<string, string> = {};

    for (const port of extraTunnelPorts) {
      const url = routeToUrl(routeByPort.get(port));
      if (url) tunnelUrls[String(port)] = url;
    }

    if (Object.keys(tunnelUrls).length > 0) {
      await this.writeTunnelEnvFile(created.session.id, tunnelUrls, correlation);
    }

    const { codeServerPort, terminalPort } = resolveServicePorts(sandboxSettings);
    const codeServerUrl = codeServerEnabled
      ? routeToUrl(routeByPort.get(codeServerPort))
      : undefined;
    const ttydUrl = sandboxSettings?.terminalEnabled
      ? routeToUrl(routeByPort.get(terminalPort))
      : undefined;

    return {
      codeServerUrl,
      codeServerPassword: codeServerEnabled
        ? await this.deriveCodeServerPassword(logicalSandboxId)
        : undefined,
      ttydUrl,
      tunnelUrls: Object.keys(tunnelUrls).length > 0 ? tunnelUrls : undefined,
    };
  }

  private async writeTunnelEnvFile(
    sessionId: string,
    tunnelUrls: Record<string, string>,
    correlation?: CreateSandboxConfig["correlation"]
  ): Promise<void> {
    const content =
      Object.entries(tunnelUrls)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([port, url]) => `TUNNEL_${port}=${url}`)
        .join("\n") + "\n";

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

  private buildRepoImageCallbackEnv(
    config: TriggerVercelRepoImageBuildConfig,
    sessionId: string
  ): Record<string, string> {
    return {
      [REPO_IMAGE_CALLBACK_ENV_KEYS[0]]: sessionId,
      [REPO_IMAGE_CALLBACK_ENV_KEYS[1]]: config.buildId,
      [REPO_IMAGE_CALLBACK_ENV_KEYS[2]]: config.callbackUrl,
      [REPO_IMAGE_CALLBACK_ENV_KEYS[3]]: config.callbackToken,
    };
  }

  private async deriveCodeServerPassword(sandboxId: string): Promise<string> {
    const digest = await computeHmacHex(
      `code-server:${sandboxId}`,
      this.providerConfig.codeServerPasswordSecret
    );
    return digest.slice(0, 32);
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
  sandboxSettings: SandboxSettings | undefined
): { allExposedPorts: number[]; extraTunnelPorts: number[] } {
  const { codeServerPort, terminalPort } = resolveServicePorts(sandboxSettings);
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
