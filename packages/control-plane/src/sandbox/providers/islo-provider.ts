/**
 * Islo sandbox provider implementation.
 *
 * Uses the official @islo-labs/sdk from the Cloudflare Worker control plane.
 * Islo owns the sandbox compute; Open-Inspect keeps session orchestration in
 * the existing Durable Object lifecycle manager.
 */

import { Islo, IsloApiError, type IsloApi } from "@islo-labs/sdk";
import { computeHmacHex, MAX_TUNNEL_PORTS } from "@open-inspect/shared";
import { createLogger } from "../../logger";
import type { CorrelationContext } from "../../logger";
import type { SourceControlProviderName } from "../../source-control";
import { buildSessionConfig } from "../sandbox-env";
import {
  SandboxProviderError,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type RestoreConfig,
  type RestoreResult,
  type ResumeConfig,
  type ResumeResult,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type SnapshotConfig,
  type SnapshotResult,
  type StopConfig,
  type StopResult,
} from "../provider";

const log = createLogger("islo-provider");

const CODE_SERVER_PORT = 8080;
const TTYD_PROXY_PORT = 7680;
const TUNNEL_ENV_FILE_PATH = "/workspace/.tunnels.env";
const EXPECTED_TUNNEL_PORTS_ENV_VAR = "EXPECTED_TUNNEL_PORTS";
const RUNTIME_LOG_PATH = "/tmp/open-inspect-runtime.log";
const RUNTIME_PID_PATH = "/tmp/open-inspect-runtime.pid";
const DEFAULT_ISLO_VCPUS = 2;
const DEFAULT_ISLO_MEMORY_MB = 4096;
const DEFAULT_ISLO_DISK_GB = 10;
const DEFAULT_ISLO_START_COMMAND = ["python3", "-m", "sandbox_runtime.entrypoint"];
const DEFAULT_SHARE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_SHARE_TTL_MS = 60 * 1000;
const SHARE_TTL_BUFFER_MS = 300 * 1000;
const SANDBOX_READY_POLL_INTERVAL_MS = 200;
const SANDBOX_READY_TIMEOUT_MS = 60_000;
const SHARE_CREATE_RETRY_INTERVAL_MS = 100;
const SHARE_CREATE_RETRY_TIMEOUT_MS = 15_000;
const SNAPSHOT_READY_POLL_INTERVAL_MS = 500;
const SNAPSHOT_READY_TIMEOUT_MS = 120_000;
const EXEC_POLL_INTERVAL_MS = 100;
const EXEC_POLL_TIMEOUT_MS = 30_000;
const RUNTIME_PREFLIGHT_TIMEOUT_MS = 15_000;
const RUNTIME_START_TIMEOUT_MS = 5_000;
const RUNTIME_EXEC_TIMEOUT_MS = 10_000;
const EXEC_CREATE_REQUEST_TIMEOUT_MS = 30_000;
const EXEC_RESULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_ISLO_BASE_IMAGE = "ghcr.io/islo-labs/background-agents-runtime:stable";
const DEFAULT_AGENT_BROWSER_EXECUTABLE_PATH = "/usr/bin/chromium";
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

export type IsloSandboxSource =
  | { type: "snapshot"; snapshotName: string }
  | { type: "image"; image: string };

export type IsloLifecyclePolicy = IsloApi.LifecyclePolicy;

type IsloRequestOptions = {
  timeoutInSeconds?: number;
  maxRetries?: number;
};

export interface IsloClientLike {
  fetch(
    input: Request | string | URL,
    init?: RequestInit,
    requestOptions?: IsloRequestOptions
  ): Promise<Response>;
  sandboxes: {
    createSandbox(
      request: IsloApi.CreateSandboxRequest,
      requestOptions?: IsloRequestOptions
    ): Promise<IsloApi.SandboxResponse>;
    getSandbox(
      request: IsloApi.GetSandboxRequest,
      requestOptions?: IsloRequestOptions
    ): Promise<IsloApi.SandboxResponse>;
    resumeSandbox(
      request: IsloApi.ResumeSandboxRequest,
      requestOptions?: IsloRequestOptions
    ): Promise<IsloApi.SandboxResponse>;
    pauseSandbox(
      request: IsloApi.PauseSandboxRequest,
      requestOptions?: IsloRequestOptions
    ): Promise<IsloApi.SandboxResponse>;
    deleteSandbox(
      request: IsloApi.DeleteSandboxRequest,
      requestOptions?: IsloRequestOptions
    ): Promise<void>;
    execInSandbox(
      request: IsloApi.ExecRequest,
      requestOptions?: IsloRequestOptions
    ): Promise<IsloApi.ExecResponse>;
    getExecResult(
      request: IsloApi.GetExecResultRequest,
      requestOptions?: IsloRequestOptions
    ): Promise<IsloApi.ExecResultResponse>;
  };
  shares: {
    listShares(
      request: IsloApi.ListSharesRequest,
      requestOptions?: IsloRequestOptions
    ): Promise<IsloApi.ShareResponse[]>;
    createShare(
      request: IsloApi.CreateShareRequest,
      requestOptions?: IsloRequestOptions
    ): Promise<IsloApi.ShareResponse>;
  };
  snapshots: {
    createSnapshot(
      request: IsloApi.SnapshotCreate,
      requestOptions?: IsloRequestOptions
    ): Promise<IsloApi.SnapshotResponse>;
    getSnapshot(
      request: IsloApi.GetSnapshotRequest,
      requestOptions?: IsloRequestOptions
    ): Promise<IsloApi.SnapshotResponse>;
    deleteSnapshot(
      request: IsloApi.DeleteSnapshotRequest,
      requestOptions?: IsloRequestOptions
    ): Promise<void>;
  };
}

export interface IsloProviderConfig {
  apiKey: string;
  baseUrl?: string;
  baseSource: IsloSandboxSource;
  lifecycle?: IsloLifecyclePolicy;
  vcpus?: number;
  memoryMb?: number;
  diskGb?: number;
  workdir?: string;
  startCommand?: string[];
  startUser?: string;
  gatewayProfile?: string;
  shareTtlSeconds?: number;
  scmProvider: SourceControlProviderName;
  /** Secret used for HMAC derivation of code-server passwords. */
  codeServerPasswordSecret: string;
}

export interface TriggerIsloRepoImageBuildConfig {
  buildId: string;
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
  callbackUrl: string;
  callbackToken: string;
  userEnvVars?: Record<string, string>;
  cloneToken?: string;
  buildTimeoutSeconds?: number;
  onProviderSessionCreated?: (providerSessionId: string) => Promise<void>;
  correlation?: CorrelationContext;
}

export interface TriggerIsloRepoImageBuildResult {
  buildId: string;
  status: string;
}

export class IsloSandboxProvider implements SandboxProvider {
  readonly name = "islo";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSnapshots: true,
    supportsRestore: true,
    supportsWarm: false,
    supportsPersistentResume: true,
    supportsExplicitStop: true,
  };

  constructor(
    private readonly client: IsloClientLike,
    private readonly providerConfig: IsloProviderConfig
  ) {}

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    const source = config.repoImageId
      ? ({ type: "snapshot", snapshotName: config.repoImageId } satisfies IsloSandboxSource)
      : this.providerConfig.baseSource;
    return this.createSandboxFromSource(config, source, {
      fromRepoImage: !!config.repoImageId,
      repoImageSha: config.repoImageSha ?? undefined,
    });
  }

  async restoreFromSnapshot(config: RestoreConfig): Promise<RestoreResult> {
    try {
      const result = await this.createSandboxFromSource(
        config,
        { type: "snapshot", snapshotName: config.snapshotImageId },
        { restoredFromSnapshot: true }
      );

      return {
        success: true,
        sandboxId: result.sandboxId,
        providerObjectId: result.providerObjectId,
        codeServerUrl: result.codeServerUrl,
        codeServerPassword: result.codeServerPassword,
        ttydUrl: result.ttydUrl,
        tunnelUrls: result.tunnelUrls,
      };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to restore Islo sandbox from snapshot", error);
    }
  }

  async takeSnapshot(config: SnapshotConfig): Promise<SnapshotResult> {
    try {
      const snapshot = await this.client.snapshots.createSnapshot({
        sandbox_name: config.providerObjectId,
        name: buildSnapshotName(config.sessionId, config.reason),
      });
      const readySnapshot = isSnapshotReady(snapshot.status)
        ? snapshot
        : await this.waitForSnapshotReady(snapshot.name);

      return { success: true, imageId: readySnapshot.name };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to snapshot Islo sandbox", error);
    }
  }

  async triggerRepoImageBuild(
    config: TriggerIsloRepoImageBuildConfig
  ): Promise<TriggerIsloRepoImageBuildResult> {
    let sandboxCreated = false;
    const sandboxName = `build-${config.repoOwner}-${config.repoName}-${Date.now()}`;

    try {
      const envVars = await this.buildBuildEnvVars(config);
      const sandbox = await this.client.sandboxes.createSandbox(
        {
          name: sandboxName,
          ...sourceToCreateRequest(this.providerConfig.baseSource),
          vcpus: this.providerConfig.vcpus ?? DEFAULT_ISLO_VCPUS,
          memory_mb: this.providerConfig.memoryMb ?? DEFAULT_ISLO_MEMORY_MB,
          disk_gb: this.providerConfig.diskGb ?? DEFAULT_ISLO_DISK_GB,
          workdir: this.providerConfig.workdir || "/workspace",
          env: envVars,
          init: { type: "minimal" },
          ...(this.providerConfig.lifecycle ? { lifecycle: this.providerConfig.lifecycle } : {}),
          ...(this.providerConfig.gatewayProfile
            ? { gateway_profile: this.providerConfig.gatewayProfile }
            : {}),
        },
        { timeoutInSeconds: config.buildTimeoutSeconds }
      );
      sandboxCreated = true;

      const readySandbox =
        sandbox.status === "running" ? sandbox : await this.waitForSandboxRunning(sandboxName);
      const providerSessionId = readySandbox.name || sandboxName;
      await config.onProviderSessionCreated?.(providerSessionId);

      await this.runStep("runtime_preflight", providerSessionId, () =>
        this.preflightRuntime(
          providerSessionId,
          {
            codeServerEnabled: false,
            terminalEnabled: false,
          },
          envVars
        )
      );
      await this.startRuntime(providerSessionId, {
        ...envVars,
        [REPO_IMAGE_CALLBACK_ENV_KEYS[0]]: providerSessionId,
      });

      log.info("islo.repo_image_build_triggered", {
        build_id: config.buildId,
        repo_owner: config.repoOwner,
        repo_name: config.repoName,
        sandbox_name: providerSessionId,
      });

      return { buildId: config.buildId, status: "building" };
    } catch (error) {
      if (sandboxCreated) {
        await this.cleanupSandboxAfterFailedCreate(sandboxName);
      }
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to trigger Islo repo image build", error);
    }
  }

  async deleteProviderImage(providerImageId: string): Promise<void> {
    try {
      await this.client.snapshots.deleteSnapshot({ name: providerImageId });
    } catch (error) {
      if (isIsloNotFound(error)) return;
      throw this.classifyError("Failed to delete Islo snapshot", error);
    }
  }

  async deleteSandbox(sandboxName: string): Promise<void> {
    try {
      await this.client.sandboxes.deleteSandbox({ sandbox_name: sandboxName });
    } catch (error) {
      if (isIsloNotFound(error)) return;
      throw this.classifyError("Failed to delete Islo sandbox", error);
    }
  }

  private async createSandboxFromSource(
    config: CreateSandboxConfig | RestoreConfig,
    source: IsloSandboxSource,
    mode: {
      restoredFromSnapshot?: boolean;
      fromRepoImage?: boolean;
      repoImageSha?: string;
    }
  ): Promise<CreateSandboxResult> {
    let sandboxCreated = false;
    try {
      const envVars = await this.buildEnvVars(config, mode);
      const sandbox = await this.runStep("create_sandbox", config.sandboxId, () =>
        this.client.sandboxes.createSandbox(
          {
            name: config.sandboxId,
            ...sourceToCreateRequest(source),
            vcpus: this.providerConfig.vcpus ?? DEFAULT_ISLO_VCPUS,
            memory_mb: this.providerConfig.memoryMb ?? DEFAULT_ISLO_MEMORY_MB,
            disk_gb: this.providerConfig.diskGb ?? DEFAULT_ISLO_DISK_GB,
            workdir: this.providerConfig.workdir || "/workspace",
            env: envVars,
            init: { type: "minimal" },
            ...(this.providerConfig.lifecycle ? { lifecycle: this.providerConfig.lifecycle } : {}),
            ...(this.providerConfig.gatewayProfile
              ? { gateway_profile: this.providerConfig.gatewayProfile }
              : {}),
          },
          { timeoutInSeconds: config.timeoutSeconds }
        )
      );
      sandboxCreated = true;
      const readySandbox =
        sandbox.status === "running"
          ? sandbox
          : await this.runStep("wait_for_running", config.sandboxId, () =>
              this.waitForSandboxRunning(config.sandboxId)
            );

      const terminalEnabled = Boolean(config.sandboxSettings?.terminalEnabled);
      await this.runStep("runtime_preflight", config.sandboxId, () =>
        this.preflightRuntime(
          config.sandboxId,
          {
            codeServerEnabled: Boolean(config.codeServerEnabled),
            terminalEnabled,
          },
          envVars
        )
      );
      const needsTunnelEnvFile =
        resolveRuntimeTunnelPorts(
          config.sandboxSettings?.tunnelPorts,
          config.codeServerEnabled,
          terminalEnabled
        ).length > 0;
      let shares: Awaited<ReturnType<IsloSandboxProvider["createShares"]>>;

      if (needsTunnelEnvFile) {
        shares = await this.runStep("create_shares", config.sandboxId, () =>
          this.createShares(config.sandboxId, config)
        );
        if (shares.tunnelUrls) {
          await this.runStep("write_tunnel_env", config.sandboxId, () =>
            this.writeTunnelEnvFile(config.sandboxId, shares.tunnelUrls!)
          );
        }
        await this.runStep("start_runtime", config.sandboxId, () =>
          this.startRuntime(config.sandboxId, envVars)
        );
      } else {
        [shares] = await Promise.all([
          this.runStep("create_shares", config.sandboxId, () =>
            this.createShares(config.sandboxId, config)
          ),
          this.runStep("start_runtime", config.sandboxId, () =>
            this.startRuntime(config.sandboxId, envVars)
          ),
        ]);
      }

      return {
        sandboxId: config.sandboxId,
        providerObjectId: config.sandboxId,
        status: readySandbox.status || sandbox.status,
        createdAt: parseTimestamp(readySandbox.created_at || sandbox.created_at),
        codeServerUrl: shares.codeServerUrl,
        codeServerPassword: shares.codeServerPassword,
        ttydUrl: shares.ttydUrl,
        tunnelUrls: shares.tunnelUrls,
      };
    } catch (error) {
      if (sandboxCreated) {
        await this.cleanupSandboxAfterFailedCreate(config.sandboxId);
      }
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to create Islo sandbox", error);
    }
  }

  async resumeSandbox(config: ResumeConfig): Promise<ResumeResult> {
    try {
      let sandbox: IsloApi.SandboxResponse;
      try {
        sandbox = await this.client.sandboxes.getSandbox({ sandbox_name: config.sandboxId });
      } catch (error) {
        if (isIsloNotFound(error)) {
          return {
            success: false,
            error: "Sandbox no longer exists in Islo",
            shouldSpawnFresh: true,
          };
        }
        throw error;
      }

      if (sandbox.deleted_at) {
        return {
          success: false,
          error: "Sandbox was deleted in Islo",
          shouldSpawnFresh: true,
        };
      }

      if (sandbox.status !== "running") {
        sandbox = await this.client.sandboxes.resumeSandbox({ sandbox_name: config.sandboxId });
      }
      if (sandbox.status !== "running") {
        sandbox = await this.waitForSandboxRunning(config.sandboxId);
      }

      const shares = await this.createShares(config.sandboxId, config);
      if (shares.tunnelUrls) {
        await this.writeTunnelEnvFile(config.sandboxId, shares.tunnelUrls);
      }

      return {
        success: true,
        providerObjectId: config.sandboxId,
        codeServerUrl: shares.codeServerUrl,
        codeServerPassword: shares.codeServerPassword,
        ttydUrl: shares.ttydUrl,
        tunnelUrls: shares.tunnelUrls,
      };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to resume Islo sandbox", error);
    }
  }

  async stopSandbox(config: StopConfig): Promise<StopResult> {
    try {
      try {
        await this.client.sandboxes.pauseSandbox({ sandbox_name: config.providerObjectId });
      } catch (error) {
        if (isIsloNotFound(error)) {
          return { success: true };
        }
        throw error;
      }
      return { success: true };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to pause Islo sandbox", error);
    }
  }

  private async buildEnvVars(
    config: CreateSandboxConfig | RestoreConfig,
    mode: {
      restoredFromSnapshot?: boolean;
      fromRepoImage?: boolean;
      repoImageSha?: string;
    } = {}
  ): Promise<Record<string, string>> {
    const envVars: Record<string, string> = { ...(config.userEnvVars ?? {}) };

    const sessionConfig = buildSessionConfig(config);

    const terminalEnabled = Boolean(config.sandboxSettings?.terminalEnabled);
    const tunnelPorts = resolveRuntimeTunnelPorts(
      config.sandboxSettings?.tunnelPorts,
      config.codeServerEnabled,
      terminalEnabled
    );

    Object.assign(envVars, {
      HOME: envVars.HOME || "/workspace",
      PYTHONPATH: envVars.PYTHONPATH ? `/app:${envVars.PYTHONPATH}` : "/app",
      NODE_PATH: envVars.NODE_PATH || "/usr/lib/node_modules",
      PATH:
        envVars.PATH || "/root/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games",
      AGENT_BROWSER_EXECUTABLE_PATH:
        envVars.AGENT_BROWSER_EXECUTABLE_PATH || DEFAULT_AGENT_BROWSER_EXECUTABLE_PATH,
      PYTHONUNBUFFERED: "1",
      SANDBOX_ID: config.sandboxId,
      CONTROL_PLANE_URL: config.controlPlaneUrl,
      SANDBOX_AUTH_TOKEN: config.sandboxAuthToken,
      REPO_OWNER: config.repoOwner ?? "",
      REPO_NAME: config.repoName ?? "",
      SESSION_CONFIG: JSON.stringify(sessionConfig),
    });

    envVars.IMAGE_BUILD_MODE = "false";
    for (const key of RESERVED_REPO_IMAGE_CALLBACK_ENV_KEYS) {
      envVars[key] = "";
    }
    envVars.VCS_CLONE_TOKEN = "";
    if (mode.restoredFromSnapshot) envVars.RESTORED_FROM_SNAPSHOT = "true";
    if (mode.fromRepoImage) {
      envVars.FROM_REPO_IMAGE = "true";
      envVars.REPO_IMAGE_SHA = mode.repoImageSha ?? "";
    }

    if (config.codeServerEnabled) {
      envVars.CODE_SERVER_PASSWORD = await this.deriveCodeServerPassword(config.sandboxId);
    }

    if (terminalEnabled) {
      envVars.TERMINAL_ENABLED = "true";
    }

    if (config.agentSlackNotifyEnabled) {
      envVars.AGENT_SLACK_NOTIFY_ENABLED = "true";
    }

    if (tunnelPorts.length > 0) {
      envVars[EXPECTED_TUNNEL_PORTS_ENV_VAR] = tunnelPorts.join(",");
    }

    if (this.providerConfig.scmProvider === "gitlab") {
      envVars.VCS_HOST = "gitlab.com";
      envVars.VCS_CLONE_USERNAME = "oauth2";
    } else {
      envVars.VCS_HOST = "github.com";
      envVars.VCS_CLONE_USERNAME = "x-access-token";
    }

    return envVars;
  }

  private async buildBuildEnvVars(
    config: TriggerIsloRepoImageBuildConfig
  ): Promise<Record<string, string>> {
    const envVars: Record<string, string> = { ...(config.userEnvVars ?? {}) };
    for (const key of RESERVED_REPO_IMAGE_CALLBACK_ENV_KEYS) {
      delete envVars[key];
    }

    Object.assign(envVars, {
      HOME: envVars.HOME || "/workspace",
      PYTHONPATH: envVars.PYTHONPATH ? `/app:${envVars.PYTHONPATH}` : "/app",
      NODE_PATH: envVars.NODE_PATH || "/usr/lib/node_modules",
      PATH:
        envVars.PATH || "/root/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games",
      AGENT_BROWSER_EXECUTABLE_PATH:
        envVars.AGENT_BROWSER_EXECUTABLE_PATH || DEFAULT_AGENT_BROWSER_EXECUTABLE_PATH,
      PYTHONUNBUFFERED: "1",
      SANDBOX_ID: `build-${config.repoOwner}-${config.repoName}`,
      REPO_OWNER: config.repoOwner,
      REPO_NAME: config.repoName,
      IMAGE_BUILD_MODE: "true",
      SESSION_CONFIG: JSON.stringify({ branch: config.defaultBranch }),
      [REPO_IMAGE_CALLBACK_ENV_KEYS[1]]: config.buildId,
      [REPO_IMAGE_CALLBACK_ENV_KEYS[2]]: config.callbackUrl,
      [REPO_IMAGE_CALLBACK_ENV_KEYS[3]]: config.callbackToken,
    });

    if (config.cloneToken) {
      envVars.VCS_CLONE_TOKEN = config.cloneToken;
    }
    if (this.providerConfig.scmProvider === "gitlab") {
      envVars.VCS_HOST = "gitlab.com";
      envVars.VCS_CLONE_USERNAME = "oauth2";
    } else {
      envVars.VCS_HOST = "github.com";
      envVars.VCS_CLONE_USERNAME = "x-access-token";
    }

    return envVars;
  }

  private async waitForSandboxRunning(sandboxName: string): Promise<IsloApi.SandboxResponse> {
    const deadline = Date.now() + SANDBOX_READY_TIMEOUT_MS;
    let lastStatus = "unknown";

    while (Date.now() < deadline) {
      try {
        const sandbox = await this.client.sandboxes.getSandbox(
          { sandbox_name: sandboxName },
          { timeoutInSeconds: boundedRequestTimeoutSeconds(deadline - Date.now()) }
        );
        lastStatus = sandbox.status || "unknown";
        if (sandbox.status === "running") {
          return sandbox;
        }
        if (["failed", "error", "stopped", "deleted"].includes(sandbox.status || "")) {
          throw new Error(`Islo sandbox entered terminal state: ${sandbox.status}`);
        }
      } catch (error) {
        if (!isIsloNotFound(error)) throw error;
      }

      await sleep(SANDBOX_READY_POLL_INTERVAL_MS);
    }

    throw new Error(
      `Timed out waiting for Islo sandbox to be running (last status: ${lastStatus})`
    );
  }

  private async waitForSnapshotReady(snapshotName: string): Promise<IsloApi.SnapshotResponse> {
    const deadline = Date.now() + SNAPSHOT_READY_TIMEOUT_MS;
    let lastStatus = "unknown";

    while (Date.now() < deadline) {
      const snapshot = await this.client.snapshots.getSnapshot(
        { name: snapshotName },
        { timeoutInSeconds: boundedRequestTimeoutSeconds(deadline - Date.now()) }
      );
      lastStatus = snapshot.status || "unknown";

      if (isSnapshotReady(snapshot.status)) {
        return snapshot;
      }
      if (isSnapshotTerminalFailure(snapshot.status)) {
        throw new Error(`Islo snapshot entered terminal state: ${snapshot.status}`);
      }

      await sleep(SNAPSHOT_READY_POLL_INTERVAL_MS);
    }

    throw new Error(`Timed out waiting for Islo snapshot to be ready (last status: ${lastStatus})`);
  }

  private async createShares(
    sandboxName: string,
    config: Pick<
      CreateSandboxConfig | ResumeConfig,
      "timeoutSeconds" | "codeServerEnabled" | "sandboxSettings"
    >
  ): Promise<{
    codeServerUrl?: string;
    codeServerPassword?: string;
    ttydUrl?: string;
    tunnelUrls?: Record<string, string>;
  }> {
    const ttlSeconds = this.resolveShareTtlSeconds(config.timeoutSeconds);
    const terminalEnabled = Boolean(config.sandboxSettings?.terminalEnabled);
    const tunnelPorts = resolveRuntimeTunnelPorts(
      config.sandboxSettings?.tunnelPorts,
      config.codeServerEnabled,
      terminalEnabled
    );

    type ShareKind = "code_server" | "ttyd" | "tunnel";
    const shareJobs: Array<{ kind: ShareKind; port: number }> = [];

    if (config.codeServerEnabled) {
      shareJobs.push({ kind: "code_server", port: CODE_SERVER_PORT });
    }

    if (terminalEnabled) {
      shareJobs.push({ kind: "ttyd", port: TTYD_PROXY_PORT });
    }

    for (const port of tunnelPorts) {
      shareJobs.push({ kind: "tunnel", port });
    }

    const [shareResults, codeServerPassword] = await Promise.all([
      Promise.all(
        shareJobs.map(async (job) => {
          const share = await this.createShareWhenSandboxReady({
            sandbox_name: sandboxName,
            port: job.port,
            ttl_seconds: ttlSeconds,
          });
          return { ...job, share };
        })
      ),
      config.codeServerEnabled
        ? this.deriveCodeServerPassword(sandboxName)
        : Promise.resolve(undefined),
    ]);

    let codeServerUrl: string | undefined;
    let ttydUrl: string | undefined;
    const tunnelUrlEntries: Array<readonly [string, string]> = [];

    for (const { kind, port, share } of shareResults) {
      if (kind === "code_server") {
        codeServerUrl = share.url;
      } else if (kind === "ttyd") {
        ttydUrl = share.url;
      } else {
        tunnelUrlEntries.push([String(port), share.url] as const);
      }
    }

    const tunnelUrls =
      tunnelUrlEntries.length > 0 ? Object.fromEntries(tunnelUrlEntries) : undefined;

    return { codeServerUrl, codeServerPassword, ttydUrl, tunnelUrls };
  }

  private async createShareWhenSandboxReady(
    request: IsloApi.CreateShareRequest
  ): Promise<Awaited<ReturnType<IsloClientLike["shares"]["createShare"]>>> {
    const deadline = Date.now() + SHARE_CREATE_RETRY_TIMEOUT_MS;

    for (;;) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;

      try {
        return await this.client.shares.createShare(request, {
          timeoutInSeconds: boundedRequestTimeoutSeconds(remainingMs),
        });
      } catch (error) {
        if (!isIsloSandboxNotRunning(error)) throw error;
      }

      await sleep(Math.min(SHARE_CREATE_RETRY_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }

    throw new Error(`Timed out creating Islo share for port ${request.port}`);
  }

  private async writeTunnelEnvFile(
    sandboxName: string,
    tunnelUrls: Record<string, string>
  ): Promise<void> {
    const content = `${Object.entries(tunnelUrls)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([port, url]) => `TUNNEL_${port}=${url}`)
      .join("\n")}\n`;
    const escapedContent = shellSingleQuote(content);
    const escapedPath = shellSingleQuote(TUNNEL_ENV_FILE_PATH);

    await this.execAndWait(sandboxName, {
      command: [
        "sh",
        "-lc",
        `mkdir -p "$(dirname ${escapedPath})" && printf %s ${escapedContent} > ${escapedPath}`,
      ],
      workdir: "/workspace",
    });
  }

  private async startRuntime(sandboxName: string, env: Record<string, string>): Promise<void> {
    const command = this.providerConfig.startCommand || DEFAULT_ISLO_START_COMMAND;
    const shellCommand = command.map(shellSingleQuote).join(" ");
    const workdir = this.providerConfig.workdir || "/workspace";
    const escapedWorkdir = shellSingleQuote(workdir);
    const escapedLogPath = shellSingleQuote(RUNTIME_LOG_PATH);
    const escapedPidPath = shellSingleQuote(RUNTIME_PID_PATH);

    await this.execAndWait(
      sandboxName,
      {
        command: [
          "sh",
          "-lc",
          `rm -f ${escapedLogPath} ${escapedPidPath}; cd ${escapedWorkdir}; nohup ${shellCommand} > ${escapedLogPath} 2>&1 & echo $! > ${escapedPidPath}; pid="$(cat ${escapedPidPath} 2>/dev/null || true)"; if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then exit 0; fi; echo "Open-Inspect runtime exited during startup"; tail -200 ${escapedLogPath} 2>/dev/null || true; exit 1`,
        ],
        workdir,
        env,
        timeout_secs: millisecondsToSeconds(RUNTIME_EXEC_TIMEOUT_MS),
        ...(this.providerConfig.startUser ? { user: this.providerConfig.startUser } : {}),
      },
      RUNTIME_START_TIMEOUT_MS
    );
  }

  private async preflightRuntime(
    sandboxName: string,
    config: { codeServerEnabled: boolean; terminalEnabled: boolean },
    env: Record<string, string>
  ): Promise<void> {
    const checks = [
      "python3 -c 'import sandbox_runtime.entrypoint'",
      "opencode --version",
      "agent-browser --version",
      'test -x "$AGENT_BROWSER_EXECUTABLE_PATH"',
      '"$AGENT_BROWSER_EXECUTABLE_PATH" --headless --no-sandbox --disable-gpu --disable-dev-shm-usage --dump-dom about:blank >/dev/null',
      "test -x /usr/local/bin/oi-git-credentials",
      'test "$(git config --system --get credential.helper)" = "/usr/local/bin/oi-git-credentials"',
      'test "$(git config --system --get credential.useHttpPath)" = "true"',
    ];
    if (config.codeServerEnabled) checks.push("code-server --version");
    if (config.terminalEnabled) checks.push("ttyd --version");

    await this.execAndWait(
      sandboxName,
      {
        command: ["sh", "-lc", checks.join(" && ")],
        workdir: this.providerConfig.workdir || "/workspace",
        env,
      },
      RUNTIME_PREFLIGHT_TIMEOUT_MS
    );
  }

  private async execAndWait(
    sandboxName: string,
    body: Omit<IsloApi.ExecRequest, "sandbox_name">,
    timeoutMs = EXEC_POLL_TIMEOUT_MS
  ): Promise<IsloApi.ExecResultResponse> {
    const execCreateTimeoutSeconds = boundedRequestTimeoutSeconds(
      timeoutMs,
      EXEC_CREATE_REQUEST_TIMEOUT_MS
    );
    const exec = await this.client.sandboxes.execInSandbox(
      { sandbox_name: sandboxName, ...body },
      { timeoutInSeconds: execCreateTimeoutSeconds }
    );
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const pollTimeoutSeconds = boundedRequestTimeoutSeconds(
        deadline - Date.now(),
        EXEC_RESULT_REQUEST_TIMEOUT_MS
      );
      const result = await this.client.sandboxes.getExecResult(
        { sandbox_name: sandboxName, exec_id: exec.exec_id },
        { timeoutInSeconds: pollTimeoutSeconds }
      );
      if (result.status === "completed" || result.status === "failed") {
        if (result.status === "failed" || (result.exit_code != null && result.exit_code !== 0)) {
          throw new Error(
            `Islo exec failed with exit code ${result.exit_code}: ${result.stderr || result.stdout || result.status}`
          );
        }
        return result;
      }
      await sleep(EXEC_POLL_INTERVAL_MS);
    }

    throw new Error(`Timed out waiting for Islo exec ${exec.exec_id}`);
  }

  private async runStep<T>(
    step: string,
    sandboxName: string,
    operation: () => Promise<T>
  ): Promise<T> {
    log.info("islo.step_start", { step, sandbox_name: sandboxName });

    try {
      const result = await operation();
      log.info("islo.step_done", { step, sandbox_name: sandboxName });
      return result;
    } catch (error) {
      log.error("islo.step_failed", {
        step,
        sandbox_name: sandboxName,
        error_message: error instanceof Error ? error.message : String(error),
      });
      throw this.classifyError(`Failed Islo step "${step}"`, error);
    }
  }

  private async cleanupSandboxAfterFailedCreate(sandboxName: string): Promise<void> {
    try {
      await this.client.sandboxes.pauseSandbox({ sandbox_name: sandboxName });
    } catch (cleanupError) {
      if (isIsloNotFound(cleanupError)) return;
      log.warn("islo.sandbox_cleanup_failed", {
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
  }

  private async deriveCodeServerPassword(sandboxId: string): Promise<string> {
    const digest = await computeHmacHex(
      `code-server:${sandboxId}`,
      this.providerConfig.codeServerPasswordSecret
    );
    return digest.slice(0, 32);
  }

  private resolveShareTtlSeconds(timeoutSeconds: number | undefined): number {
    const configured = this.providerConfig.shareTtlSeconds;
    if (configured && Number.isFinite(configured)) {
      const configuredMs = Math.floor(configured) * 1000;
      return millisecondsToSeconds(
        Math.min(MAX_SHARE_TTL_MS, Math.max(MIN_SHARE_TTL_MS, configuredMs))
      );
    }
    if (!timeoutSeconds) return millisecondsToSeconds(DEFAULT_SHARE_TTL_MS);
    const timeoutMs = timeoutSeconds * 1000 + SHARE_TTL_BUFFER_MS;
    return millisecondsToSeconds(Math.min(MAX_SHARE_TTL_MS, Math.max(MIN_SHARE_TTL_MS, timeoutMs)));
  }

  private classifyError(message: string, error: unknown): SandboxProviderError {
    if (error instanceof IsloApiError) {
      return SandboxProviderError.fromFetchError(
        `${message}: ${error.message}`,
        error,
        error.statusCode
      );
    }
    return SandboxProviderError.fromFetchError(message, error);
  }
}

function resolveTunnelPorts(rawPorts: number[] | undefined): number[] {
  if (!rawPorts) return [];
  const ports: number[] = [];
  for (const value of rawPorts) {
    if (Number.isInteger(value) && value >= 1 && value <= 65535) {
      ports.push(value);
    }
    if (ports.length >= MAX_TUNNEL_PORTS) break;
  }
  return ports;
}

function resolveRuntimeTunnelPorts(
  rawPorts: number[] | undefined,
  codeServerEnabled: boolean | undefined,
  terminalEnabled: boolean
): number[] {
  return resolveTunnelPorts(rawPorts).filter((port) => {
    if (codeServerEnabled && port === CODE_SERVER_PORT) return false;
    if (terminalEnabled && port === TTYD_PROXY_PORT) return false;
    return true;
  });
}

function parseTimestamp(value: string | null | undefined): number {
  if (!value) return Date.now();
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function boundedRequestTimeoutSeconds(remainingMs: number, maxTimeoutMs = remainingMs): number {
  return Math.max(1, millisecondsToSeconds(Math.min(remainingMs, maxTimeoutMs)));
}

function millisecondsToSeconds(valueMs: number): number {
  return Math.ceil(valueMs / 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSnapshotReady(status: string | null | undefined): boolean {
  return ["ready", "created", "completed"].includes(status || "");
}

function isSnapshotTerminalFailure(status: string | null | undefined): boolean {
  return ["failed", "error", "deleted"].includes(status || "");
}

function isIsloNotFound(error: unknown): boolean {
  return error instanceof IsloApiError && error.statusCode === 404;
}

function isIsloSandboxNotRunning(error: unknown): boolean {
  return (
    error instanceof IsloApiError && error.statusCode === 400 && /not running/i.test(error.message)
  );
}

export function createIsloProvider(config: IsloProviderConfig): IsloSandboxProvider {
  if (!config.apiKey) {
    throw new Error("createIsloProvider requires apiKey");
  }
  if (!isValidIsloSource(config.baseSource)) {
    throw new Error("createIsloProvider requires baseSource");
  }
  if (!config.codeServerPasswordSecret) {
    throw new Error("createIsloProvider requires codeServerPasswordSecret");
  }

  const client = new Islo({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
  }) as IsloClientLike;

  log.info("islo.provider_created", {
    base_source: config.baseSource.type,
    vcpus: config.vcpus ?? DEFAULT_ISLO_VCPUS,
    memory_mb: config.memoryMb ?? DEFAULT_ISLO_MEMORY_MB,
    disk_gb: config.diskGb ?? DEFAULT_ISLO_DISK_GB,
  });

  return new IsloSandboxProvider(client, config);
}

export function createDefaultIsloSource(
  baseSnapshot?: string,
  baseImage?: string
): IsloSandboxSource {
  const snapshotName = baseSnapshot?.trim();
  if (snapshotName) return { type: "snapshot", snapshotName };
  const image = baseImage?.trim() || DEFAULT_ISLO_BASE_IMAGE;
  return { type: "image", image };
}

function sourceToCreateRequest(
  source: IsloSandboxSource
): Pick<IsloApi.CreateSandboxRequest, "image" | "snapshot_name"> {
  return source.type === "snapshot"
    ? { snapshot_name: source.snapshotName }
    : { image: source.image };
}

function isValidIsloSource(source: IsloSandboxSource | undefined): source is IsloSandboxSource {
  if (!source) return false;
  return source.type === "snapshot"
    ? source.snapshotName.trim().length > 0
    : source.image.trim().length > 0;
}

function buildSnapshotName(sessionId: string, reason: string): string {
  const safeSession = sanitizeSnapshotPart(sessionId).slice(0, 48) || "session";
  const safeReason = sanitizeSnapshotPart(reason).slice(0, 32) || "snapshot";
  return `oi-${safeSession}-${safeReason}-${Date.now()}`;
}

function sanitizeSnapshotPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
