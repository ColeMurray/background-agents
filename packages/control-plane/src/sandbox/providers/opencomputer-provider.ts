/**
 * OpenComputer sandbox provider.
 *
 * Uses an OpenComputer declarative template that already contains the
 * OpenInspect sandbox runtime. Resume maps to wake; idle hibernation is left
 * to OpenComputer rather than being driven by OpenInspect's lifecycle manager.
 */

import {
  computeHmacHex,
  DEFAULT_BUILD_TIMEOUT_SECONDS,
  type SandboxSettings,
} from "@open-inspect/shared";
import { resolveServicePorts, resolveTunnelPorts } from "./port-resolution";
import { createLogger } from "../../logger";
import type { SourceControlProviderName } from "../../source-control";
import {
  OPENCOMPUTER_CHECKPOINT_KIND,
  OPENCOMPUTER_CHECKPOINT_RETENTION_POLICY,
  OpenComputerApiError,
  OpenComputerNotFoundError,
  type OpenComputerRestClient,
  type OpenComputerSandboxResponse,
  type OpenComputerSecretStoreResponse,
} from "../opencomputer-rest-client";
import { buildSessionConfig } from "../sandbox-env";
import {
  SandboxProviderError,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type ResumeConfig,
  type ResumeResult,
  type RestoreConfig,
  type RestoreResult,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type SnapshotConfig,
  type SnapshotResult,
  type StopConfig,
  type StopResult,
} from "../provider";

const log = createLogger("opencomputer-provider");
const OPENCOMPUTER_SECRET_STORE_EGRESS_ALLOWLIST = ["*"];
const OPENCOMPUTER_PROVIDER_TIMEOUT_FALLBACK_SECONDS = 10 * 60;
const REPO_IMAGE_CALLBACK_ENV_KEYS = [
  "OI_REPO_IMAGE_PROVIDER_SESSION_ID",
  "OI_REPO_IMAGE_BUILD_ID",
  "OI_REPO_IMAGE_CALLBACK_URL",
  "OI_REPO_IMAGE_CALLBACK_TOKEN",
] as const;

export interface TriggerOpenComputerRepoImageBuildConfig {
  buildId: string;
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
  callbackUrl: string;
  callbackToken: string;
  userEnvVars?: Record<string, string>;
  buildTimeoutSeconds?: number;
  onProviderSessionCreated?: (providerSessionId: string) => Promise<void>;
}

export interface TriggerOpenComputerRepoImageBuildResult {
  buildId: string;
  status: string;
}

export interface OpenComputerProviderConfig {
  scmProvider: SourceControlProviderName;
  /** Secret used for deterministic code-server password derivation */
  codeServerPasswordSecret: string;
  /** Provider-level LLM credentials to expose to the sandbox runtime. */
  llmEnvVars?: Record<string, string | undefined>;
}

export class OpenComputerSandboxProvider implements SandboxProvider {
  readonly name = "opencomputer";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSnapshots: true,
    supportsRestore: true,
    supportsWarm: false,
    supportsPersistentResume: true,
    supportsExplicitStop: true,
  };

  constructor(
    private readonly client: OpenComputerRestClient,
    private readonly providerConfig: OpenComputerProviderConfig
  ) {}

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    let secretStore: OpenComputerSecretStoreResponse | undefined;
    let providerObjectId: string | undefined;
    try {
      const envVars = await this.buildRuntimeEnvVars(config, {
        fromRepoImage: !!config.repoImageId,
        repoImageSha: config.repoImageSha ?? undefined,
      });
      secretStore = await this.createSecretStoreFor(config.sessionId, config.userEnvVars);
      const labels = this.buildLabels(config);
      const timeoutSeconds = resolveOpenComputerTimeoutSeconds(config.timeoutSeconds);
      const sandbox = config.repoImageId
        ? await this.client.forkFromCheckpoint({
            checkpointId: config.repoImageId,
            name: config.sandboxId,
            env: envVars,
            labels,
            timeoutSeconds,
            secretStore: secretStore?.name,
          })
        : await this.client.createSandbox({
            name: config.sandboxId,
            template: this.client.config.template,
            env: envVars,
            labels,
            timeoutSeconds,
            secretStore: secretStore?.name,
            projectId: this.client.config.projectId,
            target: this.client.config.target,
          });
      providerObjectId = sandbox.id;
      await this.client.setSandboxTimeout(providerObjectId, timeoutSeconds);
      await this.client.startRuntime(providerObjectId);
      const tunnels = await this.buildTunnelUrls(
        providerObjectId,
        config.sandboxId,
        config.codeServerEnabled,
        config.sandboxSettings,
        sandbox
      );

      return {
        sandboxId: config.sandboxId,
        providerObjectId,
        status: sandbox.state ?? sandbox.status ?? "created",
        createdAt: Date.now(),
        codeServerUrl: tunnels.codeServerUrl,
        codeServerPassword: tunnels.codeServerPassword,
        tunnelUrls: tunnels.tunnelUrls,
      };
    } catch (error) {
      if (providerObjectId) {
        await this.cleanupSandboxAfterFailedCreate(providerObjectId, config.sessionId);
      }
      if (secretStore) {
        try {
          await this.client.deleteSecretStore(secretStore.id);
        } catch (cleanupError) {
          log.warn("opencomputer.secret_store_cleanup_failed", {
            session_id: config.sessionId,
            secret_store_id: secretStore.id,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      }
      throw this.classifyError("Failed to create OpenComputer sandbox", error);
    }
  }

  async restoreFromSnapshot(config: RestoreConfig): Promise<RestoreResult> {
    let secretStore: OpenComputerSecretStoreResponse | undefined;
    let providerObjectId: string | undefined;
    try {
      const envVars = await this.buildRuntimeEnvVars(config, { restoredFromSnapshot: true });
      secretStore = await this.createSecretStoreFor(config.sessionId, config.userEnvVars);
      const sandbox = await this.client.forkFromCheckpoint({
        checkpointId: config.snapshotImageId,
        name: config.sandboxId,
        env: envVars,
        labels: this.buildLabels(config),
        timeoutSeconds: resolveOpenComputerTimeoutSeconds(config.timeoutSeconds),
        secretStore: secretStore?.name,
      });
      providerObjectId = sandbox.id;
      await this.client.setSandboxTimeout(
        providerObjectId,
        resolveOpenComputerTimeoutSeconds(config.timeoutSeconds)
      );
      await this.client.startRuntime(providerObjectId);
      const tunnels = await this.buildTunnelUrls(
        providerObjectId,
        config.sandboxId,
        config.codeServerEnabled,
        config.sandboxSettings,
        sandbox
      );

      return {
        success: true,
        sandboxId: config.sandboxId,
        providerObjectId,
        codeServerUrl: tunnels.codeServerUrl,
        codeServerPassword: tunnels.codeServerPassword,
        tunnelUrls: tunnels.tunnelUrls,
      };
    } catch (error) {
      if (providerObjectId) {
        await this.cleanupSandboxAfterFailedCreate(providerObjectId, config.sessionId);
      }
      if (secretStore) {
        try {
          await this.client.deleteSecretStore(secretStore.id);
        } catch (cleanupError) {
          log.warn("opencomputer.secret_store_cleanup_failed", {
            session_id: config.sessionId,
            secret_store_id: secretStore.id,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      }
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to restore OpenComputer sandbox from checkpoint", error);
    }
  }

  async takeSnapshot(config: SnapshotConfig): Promise<SnapshotResult> {
    try {
      const checkpoint = await this.client.createCheckpoint(
        config.providerObjectId,
        this.buildCheckpointName(config.sessionId, config.reason),
        {
          kind: OPENCOMPUTER_CHECKPOINT_KIND,
          retentionPolicy: OPENCOMPUTER_CHECKPOINT_RETENTION_POLICY,
        }
      );

      if (
        checkpoint.status &&
        checkpoint.status !== "ready" &&
        checkpoint.status !== "created" &&
        checkpoint.status !== "processing"
      ) {
        return { success: false, error: `Checkpoint status was ${checkpoint.status}` };
      }

      return { success: true, imageId: checkpoint.id };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to checkpoint OpenComputer sandbox", error);
    }
  }

  async resumeSandbox(config: ResumeConfig): Promise<ResumeResult> {
    try {
      let sandbox: OpenComputerSandboxResponse;
      try {
        sandbox = await this.client.getSandbox(config.providerObjectId);
      } catch (error) {
        if (error instanceof OpenComputerNotFoundError) {
          return {
            success: false,
            error: "Sandbox no longer exists in OpenComputer",
            shouldSpawnFresh: true,
          };
        }
        throw error;
      }

      const state = (sandbox.state ?? sandbox.status ?? "").toLowerCase();
      let wokeSandbox = false;
      if (state !== "running" && state !== "started" && state !== "ready") {
        const wakeResult = await this.client.wakeSandbox(config.providerObjectId);
        if (wakeResult && typeof wakeResult === "object") sandbox = wakeResult;
        wokeSandbox = true;
      }

      if (wokeSandbox) {
        await this.client.setSandboxTimeout(
          config.providerObjectId,
          resolveOpenComputerTimeoutSeconds(config.timeoutSeconds)
        );
        await this.client.startRuntime(config.providerObjectId);
      }

      let codeServerUrl: string | undefined;
      let codeServerPassword: string | undefined;
      let tunnelUrls: Record<string, string> | undefined;
      try {
        const tunnels = await this.buildTunnelUrls(
          config.providerObjectId,
          config.sandboxId,
          config.codeServerEnabled,
          config.sandboxSettings,
          sandbox
        );
        codeServerUrl = tunnels.codeServerUrl;
        codeServerPassword = tunnels.codeServerPassword;
        tunnelUrls = tunnels.tunnelUrls;
      } catch (error) {
        log.warn("opencomputer.resume_tunnel_urls_failed", {
          sandbox_id: config.sandboxId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      return {
        success: true,
        providerObjectId: sandbox.id || config.providerObjectId,
        codeServerUrl,
        codeServerPassword,
        tunnelUrls,
      };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to resume OpenComputer sandbox", error);
    }
  }

  async stopSandbox(config: StopConfig): Promise<StopResult> {
    try {
      try {
        await this.client.hibernateSandbox(config.providerObjectId);
      } catch (error) {
        if (error instanceof OpenComputerNotFoundError) return { success: true };
        throw error;
      }
      return { success: true };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to hibernate OpenComputer sandbox", error);
    }
  }

  async triggerRepoImageBuild(
    config: TriggerOpenComputerRepoImageBuildConfig
  ): Promise<TriggerOpenComputerRepoImageBuildResult> {
    let secretStore: OpenComputerSecretStoreResponse | undefined;
    try {
      const sandboxName = `build-${config.repoOwner}-${config.repoName}-${Date.now()}`;
      const envVars = await this.buildBuildEnvVars(config);
      secretStore = await this.createSecretStoreFor(config.buildId, config.userEnvVars);
      const sandbox = await this.client.createSandbox({
        name: sandboxName,
        template: this.client.config.template,
        env: envVars,
        labels: {
          openinspect_framework: "open-inspect",
          openinspect_provider: "opencomputer",
          openinspect_kind: "repo-image-build",
          openinspect_build_id: config.buildId,
          openinspect_repo: `${config.repoOwner}/${config.repoName}`,
        },
        timeoutSeconds: config.buildTimeoutSeconds ?? DEFAULT_BUILD_TIMEOUT_SECONDS,
        secretStore: secretStore?.name,
        projectId: this.client.config.projectId,
        target: this.client.config.target,
      });

      if (config.onProviderSessionCreated) {
        await config.onProviderSessionCreated(sandbox.id);
      }

      await this.client.startRuntime(sandbox.id, {
        [REPO_IMAGE_CALLBACK_ENV_KEYS[0]]: sandbox.id,
      });
      log.info("opencomputer.repo_image_build_triggered", {
        build_id: config.buildId,
        repo_owner: config.repoOwner,
        repo_name: config.repoName,
        sandbox_id: sandbox.id,
      });

      return { buildId: config.buildId, status: "building" };
    } catch (error) {
      if (secretStore) {
        try {
          await this.client.deleteSecretStore(secretStore.id);
        } catch (cleanupError) {
          log.warn("opencomputer.secret_store_cleanup_failed", {
            build_id: config.buildId,
            secret_store_id: secretStore.id,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      }
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to trigger OpenComputer repo image build", error);
    }
  }

  async deleteProviderImage(
    providerImageId: string,
    providerSessionId?: string | null
  ): Promise<void> {
    if (!providerSessionId) return;
    try {
      await this.client.deleteCheckpoint(providerSessionId, providerImageId);
    } catch (error) {
      if (error instanceof OpenComputerNotFoundError) return;
      throw this.classifyError("Failed to delete OpenComputer checkpoint", error);
    }
  }

  private async buildRuntimeEnvVars(
    config: CreateSandboxConfig | RestoreConfig,
    mode: {
      restoredFromSnapshot?: boolean;
      fromRepoImage?: boolean;
      repoImageSha?: string;
    } = {}
  ): Promise<Record<string, string>> {
    const envVars: Record<string, string> = {};
    const sessionConfig = buildSessionConfig(config);

    for (const [name, value] of Object.entries(config.userEnvVars ?? {})) {
      if (value) envVars[name] = value;
    }
    for (const [name, value] of Object.entries(this.providerConfig.llmEnvVars ?? {})) {
      if (value) envVars[name] = value;
    }

    Object.assign(envVars, {
      PYTHONUNBUFFERED: "1",
      SANDBOX_ID: config.sandboxId,
      CONTROL_PLANE_URL: config.controlPlaneUrl,
      SANDBOX_AUTH_TOKEN: config.sandboxAuthToken,
      REPOSITORY_MODE: config.repoOwner && config.repoName ? "single" : "none",
      REPO_OWNER: config.repoOwner ?? "",
      REPO_NAME: config.repoName ?? "",
      SESSION_CONFIG: JSON.stringify(sessionConfig),
    });

    if (config.codeServerEnabled) {
      envVars.CODE_SERVER_PASSWORD = await this.deriveCodeServerPassword(config.sandboxId);
      envVars.CODE_SERVER_PORT = String(resolveServicePorts(config.sandboxSettings).codeServerPort);
    }

    if (config.agentSlackNotifyEnabled) {
      envVars.AGENT_SLACK_NOTIFY_ENABLED = "true";
    }
    if (mode.restoredFromSnapshot) envVars.RESTORED_FROM_SNAPSHOT = "true";
    if (mode.fromRepoImage) {
      envVars.FROM_REPO_IMAGE = "true";
      envVars.REPO_IMAGE_SHA = mode.repoImageSha ?? "";
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
    config: TriggerOpenComputerRepoImageBuildConfig
  ): Promise<Record<string, string>> {
    const envVars: Record<string, string> = {};

    for (const [name, value] of Object.entries(config.userEnvVars ?? {})) {
      if (value) envVars[name] = value;
    }
    for (const [name, value] of Object.entries(this.providerConfig.llmEnvVars ?? {})) {
      if (value) envVars[name] = value;
    }

    Object.assign(envVars, {
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

    if (this.providerConfig.scmProvider === "gitlab") {
      envVars.VCS_HOST = "gitlab.com";
      envVars.VCS_CLONE_USERNAME = "oauth2";
    } else {
      envVars.VCS_HOST = "github.com";
      envVars.VCS_CLONE_USERNAME = "x-access-token";
    }

    return envVars;
  }

  private async createSecretStoreFor(
    id: string,
    userEnvVars: Record<string, string> = {}
  ): Promise<OpenComputerSecretStoreResponse> {
    const entries = Object.entries(userEnvVars).filter(([, value]) => value.length > 0);

    const store = await this.client.createSecretStore({
      name: this.buildSecretStoreName(id),
      egressAllowlist: OPENCOMPUTER_SECRET_STORE_EGRESS_ALLOWLIST,
    });

    try {
      await Promise.all(
        entries.map(([name, value]) =>
          this.client.setSecret({
            storeId: store.id,
            name,
            value,
            allowedHosts: this.allowedHostsForSecret(name),
          })
        )
      );
      return store;
    } catch (error) {
      try {
        await this.client.deleteSecretStore(store.id);
      } catch (cleanupError) {
        log.warn("opencomputer.secret_store_cleanup_failed", {
          session_id: id,
          secret_store_id: store.id,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
      throw error;
    }
  }

  private buildSecretStoreName(sessionId: string): string {
    return `openinspect-${sessionId.slice(0, 32)}`;
  }

  private buildCheckpointName(sessionId: string, reason: string): string {
    const safeReason = reason.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40) || "snapshot";
    return `openinspect-${sessionId.slice(0, 32)}-${safeReason}-${Date.now()}`;
  }

  private allowedHostsForSecret(name: string): string[] | undefined {
    const normalized = name.toUpperCase();
    if (normalized.includes("ANTHROPIC")) return ["api.anthropic.com"];
    if (normalized.includes("OPENAI")) return ["api.openai.com"];
    if (normalized.includes("GITHUB") || normalized.includes("VCS_CLONE")) {
      return this.providerConfig.scmProvider === "gitlab"
        ? ["gitlab.com", "api.gitlab.com"]
        : ["github.com", "api.github.com"];
    }
    return undefined;
  }

  private async cleanupSandboxAfterFailedCreate(
    providerObjectId: string,
    sessionId: string
  ): Promise<void> {
    try {
      await this.client.deleteSandbox(providerObjectId);
    } catch (cleanupError) {
      log.warn("opencomputer.sandbox_cleanup_failed", {
        session_id: sessionId,
        provider_object_id: providerObjectId,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
  }

  private buildLabels(config: CreateSandboxConfig | RestoreConfig): Record<string, string> {
    return {
      openinspect_framework: "open-inspect",
      openinspect_provider: "opencomputer",
      openinspect_session_id: config.sessionId,
      openinspect_expected_sandbox_id: config.sandboxId,
      ...(config.repoOwner && config.repoName
        ? { openinspect_repo: `${config.repoOwner}/${config.repoName}` }
        : {}),
    };
  }

  private async buildTunnelUrls(
    providerObjectId: string,
    logicalSandboxId: string,
    codeServerEnabled: boolean | undefined,
    sandboxSettings: SandboxSettings | undefined,
    sandbox?: OpenComputerSandboxResponse
  ): Promise<{
    codeServerUrl?: string;
    codeServerPassword?: string;
    tunnelUrls?: Record<string, string>;
  }> {
    const routeUrls = this.routeUrlsFromSandbox(sandbox);
    const { codeServerPort } = resolveServicePorts(sandboxSettings);
    let tunnelPorts = resolveTunnelPorts(sandboxSettings?.tunnelPorts);
    let codeServerUrl: string | undefined;
    let codeServerPassword: string | undefined;

    if (codeServerEnabled) {
      codeServerUrl =
        routeUrls[String(codeServerPort)] ??
        (await this.client.getTunnelUrl(providerObjectId, codeServerPort)).url;
      codeServerPassword = await this.deriveCodeServerPassword(logicalSandboxId);
      tunnelPorts = tunnelPorts.filter((port) => port !== codeServerPort);
    }

    let tunnelUrls: Record<string, string> | undefined;
    if (tunnelPorts.length > 0) {
      const entries = await Promise.all(
        tunnelPorts.map(async (port) => {
          const url =
            routeUrls[String(port)] ?? (await this.client.getTunnelUrl(providerObjectId, port)).url;
          return [String(port), url] as const;
        })
      );
      tunnelUrls = Object.fromEntries(entries);
    }

    return { codeServerUrl, codeServerPassword, tunnelUrls };
  }

  private routeUrlsFromSandbox(sandbox?: OpenComputerSandboxResponse): Record<string, string> {
    if (!sandbox) return {};
    if (sandbox.tunnelUrls) return sandbox.tunnelUrls;
    if (sandbox.sandboxDomain) {
      const sandboxId = sandbox.id || sandbox.sandboxID;
      if (!sandboxId) return {};
      return new Proxy<Record<string, string>>(
        {},
        {
          get: (_target, property) =>
            typeof property === "string"
              ? `https://${sandboxId}-p${property}.${sandbox.sandboxDomain}`
              : undefined,
        }
      );
    }
    if (!sandbox.routes) return {};
    return Object.fromEntries(sandbox.routes.map((route) => [String(route.port), route.url]));
  }

  private async deriveCodeServerPassword(sandboxId: string): Promise<string> {
    const digest = await computeHmacHex(
      `code-server:${sandboxId}`,
      this.providerConfig.codeServerPasswordSecret
    );
    return digest.slice(0, 32);
  }

  private classifyError(message: string, error: unknown): SandboxProviderError {
    if (error instanceof OpenComputerApiError) {
      return SandboxProviderError.fromFetchError(
        `${message}: ${error.message}`,
        error,
        error.status
      );
    }
    return SandboxProviderError.fromFetchError(message, error);
  }
}

function resolveOpenComputerTimeoutSeconds(timeoutSeconds: number | undefined): number {
  return timeoutSeconds ?? OPENCOMPUTER_PROVIDER_TIMEOUT_FALLBACK_SECONDS;
}

export function createOpenComputerProvider(
  client: OpenComputerRestClient,
  providerConfig: OpenComputerProviderConfig
): OpenComputerSandboxProvider {
  return new OpenComputerSandboxProvider(client, providerConfig);
}
