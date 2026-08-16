/**
 * OpenComputer sandbox provider.
 *
 * Uses an OpenComputer declarative template that already contains the
 * OpenInspect sandbox runtime. Resume maps to wake; idle hibernation is left
 * to OpenComputer rather than being driven by OpenInspect's lifecycle manager.
 */

import type { SandboxSettings } from "@open-inspect/shared/types/integrations";
import { resolveServicePorts, resolveTunnelPorts } from "./port-resolution";
import { createLogger } from "../../logger";
import type { SourceControlProviderName } from "../../source-control";
import {
  OPENCOMPUTER_CHECKPOINT_KIND,
  OPENCOMPUTER_CHECKPOINT_RETENTION_POLICY,
  OpenComputerApiError,
  OpenComputerNotFoundError,
  type OpenComputerDeleteSandboxOptions,
  type OpenComputerRestClient,
  type OpenComputerSandboxResponse,
  type OpenComputerSecretStoreResponse,
} from "../opencomputer-rest-client";
import {
  buildImageBuildCallbackEnv,
  buildImageBuildEnvVars,
  buildSandboxEnvVars,
  deriveCodeServerPassword,
  deriveVncPassword,
  IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_KEY,
  IMAGE_BUILD_MODE_ENV_VAR,
  imageBuildSandboxIdentity,
  REPO_IMAGE_CALLBACK_ENV,
  RESERVED_REPO_IMAGE_CALLBACK_ENV_KEYS,
  scmCloneIdentity,
  VCS_CLONE_TOKEN_ENV_VAR,
} from "../sandbox-env";
import {
  SandboxProviderError,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type ImageBuildProviderTriggerConfig,
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
  type VncAccess,
} from "../provider";

const log = createLogger("opencomputer-provider");
const OPENCOMPUTER_SECRET_STORE_EGRESS_ALLOWLIST = ["*"];
const RESERVED_VNC_ENV_KEYS = ["VNC_PASSWORD", "NOVNC_PORT"] as const;

export interface OpenComputerProviderConfig {
  scmProvider: SourceControlProviderName;
  /** Secret used for domain-separated sandbox access password derivation. */
  sandboxAccessPasswordSecret: string;
  /** Provider-level LLM credentials to expose to the sandbox runtime. */
  llmEnvVars?: Record<string, string | undefined>;
}

interface PreparedOpenComputerEnvironment {
  envVars: Record<string, string>;
  secretEnvVars?: Record<string, string>;
}

export class OpenComputerSandboxProvider implements SandboxProvider {
  readonly name = "opencomputer";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSandboxTimeout: true,
    supportsSnapshots: true,
    supportsRestore: true,
    supportsPersistentResume: true,
    supportsExplicitStop: true,
  };

  constructor(
    private readonly client: OpenComputerRestClient,
    private readonly providerConfig: OpenComputerProviderConfig
  ) {}

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    const template = config.prebuiltImageId ? undefined : this.requireTemplate();
    let secretStore: OpenComputerSecretStoreResponse | undefined;
    let providerObjectId: string | undefined;
    try {
      const environment = await this.buildRuntimeEnvironment(config, {
        fromPrebuiltImage: !!config.prebuiltImageId,
        prebuiltImageSha: config.prebuiltImageSha ?? undefined,
      });
      secretStore = await this.createSecretStoreFor(config.sessionId, environment.secretEnvVars);
      const labels = this.buildLabels(config);
      const timeoutSeconds = config.timeoutSeconds;
      const sandbox = config.prebuiltImageId
        ? await this.client.forkFromCheckpoint({
            checkpointId: config.prebuiltImageId,
            name: config.sandboxId,
            env: environment.envVars,
            labels,
            ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
            secretStore: secretStore?.name,
          })
        : await this.client.createSandbox({
            name: config.sandboxId,
            template: template ?? this.requireTemplate(),
            env: environment.envVars,
            labels,
            ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
            secretStore: secretStore?.name,
          });
      providerObjectId = sandbox.id;
      if (timeoutSeconds !== undefined) {
        await this.client.setSandboxTimeout(providerObjectId, timeoutSeconds);
      }
      await this.client.startRuntime(providerObjectId);
      const tunnels = await this.buildTunnelUrls(
        providerObjectId,
        config.sandboxId,
        config.codeServerEnabled,
        config.vncEnabled,
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
        vncAccess: tunnels.vncAccess,
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
      const environment = await this.buildRuntimeEnvironment(config, {
        restoredFromSnapshot: true,
      });
      secretStore = await this.createSecretStoreFor(config.sessionId, environment.secretEnvVars);
      const timeoutSeconds = config.timeoutSeconds;
      const sandbox = await this.client.forkFromCheckpoint({
        checkpointId: config.snapshotImageId,
        name: config.sandboxId,
        env: environment.envVars,
        labels: this.buildLabels(config),
        ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
        secretStore: secretStore?.name,
      });
      providerObjectId = sandbox.id;
      if (timeoutSeconds !== undefined) {
        await this.client.setSandboxTimeout(providerObjectId, timeoutSeconds);
      }
      await this.client.startRuntime(providerObjectId);
      const tunnels = await this.buildTunnelUrls(
        providerObjectId,
        config.sandboxId,
        config.codeServerEnabled,
        config.vncEnabled,
        config.sandboxSettings,
        sandbox
      );

      return {
        success: true,
        sandboxId: config.sandboxId,
        providerObjectId,
        codeServerUrl: tunnels.codeServerUrl,
        codeServerPassword: tunnels.codeServerPassword,
        vncAccess: tunnels.vncAccess,
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
        },
        ...(config.signal ? [config.signal] : [])
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
        if (wakeResult) sandbox = wakeResult;
        wokeSandbox = true;
      }

      const timeoutSeconds = config.timeoutSeconds;
      if (timeoutSeconds !== undefined) {
        await this.client.setSandboxTimeout(config.providerObjectId, timeoutSeconds);
      }
      if (wokeSandbox) {
        await this.client.startRuntime(config.providerObjectId);
      }

      let codeServerUrl: string | undefined;
      let codeServerPassword: string | undefined;
      let vncAccess: VncAccess | undefined;
      let tunnelUrls: Record<string, string> | undefined;
      try {
        const tunnels = await this.buildTunnelUrls(
          config.providerObjectId,
          config.sandboxId,
          config.codeServerEnabled,
          config.vncEnabled,
          config.sandboxSettings,
          sandbox
        );
        codeServerUrl = tunnels.codeServerUrl;
        codeServerPassword = tunnels.codeServerPassword;
        vncAccess = tunnels.vncAccess;
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
        vncAccess,
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
        if (config.reason === "respawn") {
          await this.client.deleteSandbox(
            config.providerObjectId,
            { deleteSecretStore: true },
            ...(config.signal ? [config.signal] : [])
          );
        } else {
          await this.client.hibernateSandbox(config.providerObjectId);
        }
      } catch (error) {
        if (error instanceof OpenComputerNotFoundError) return { success: true };
        throw error;
      }
      return { success: true };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError(
        `Failed to ${config.reason === "respawn" ? "delete" : "hibernate"} OpenComputer sandbox`,
        error
      );
    }
  }

  /**
   * Permanently delete a sandbox. Used to tear down ephemeral repo-image build
   * sandboxes once their checkpoint has been taken: stopSandbox only hibernates
   * (pause-for-resume), which is correct for idle sessions but would leak the
   * single-use build sandbox. Idempotent — a missing sandbox is treated as
   * already deleted.
   */
  async deleteSandbox(
    providerObjectId: string,
    options?: OpenComputerDeleteSandboxOptions,
    signal?: AbortSignal
  ): Promise<void> {
    try {
      await this.client.deleteSandbox(providerObjectId, options, ...(signal ? [signal] : []));
    } catch (error) {
      if (error instanceof OpenComputerNotFoundError) return;
      throw this.classifyError("Failed to delete OpenComputer sandbox", error);
    }
  }

  /**
   * Trigger an OpenComputer environment-image build (design §7.3). The
   * SESSION_CONFIG carries the repository list so the list-native runtime
   * clones and sets up every repository.
   */
  async triggerImageBuild(config: ImageBuildProviderTriggerConfig): Promise<void> {
    const template = this.requireTemplate();
    let secretStore: OpenComputerSecretStoreResponse | undefined;
    let providerObjectId: string | undefined;
    try {
      const identity = imageBuildSandboxIdentity(config, Date.now());
      const environment = this.buildBuildEnvironment(config, identity.sandboxId);
      secretStore = await this.createSecretStoreFor(config.buildId, environment.secretEnvVars);
      const sandbox = await this.client.createSandbox({
        name: identity.sandboxName,
        template,
        env: environment.envVars,
        labels: {
          openinspect_provider: "opencomputer",
          ...identity.labels,
          // Legacy alias preserved for existing OpenComputer operator queries.
          openinspect_environment: config.scopeId,
        },
        timeoutSeconds: config.providerSessionTimeoutSeconds,
        secretStore: secretStore?.name,
      });
      providerObjectId = sandbox.id;

      await config.onProviderSessionCreated(sandbox.id);

      await this.client.startRuntime(sandbox.id, {
        [REPO_IMAGE_CALLBACK_ENV.providerSessionId]: sandbox.id,
      });
      // The OpenComputer REST client takes no correlation argument, so the
      // trace cannot be forwarded downstream yet — it is recorded on this
      // trigger log line only. Spread first so the explicit fields (notably
      // sandbox_id, the new build sandbox) win over correlation's.
      log.info("opencomputer.environment_image_build_triggered", {
        ...config.correlation,
        build_id: config.buildId,
        scope_kind: config.scopeKind,
        scope_id: config.scopeId,
        sandbox_id: sandbox.id,
      });
    } catch (error) {
      if (providerObjectId) {
        await this.cleanupSandboxAfterFailedCreate(providerObjectId, config.buildId);
      }
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
      throw this.classifyError("Failed to trigger OpenComputer environment image build", error);
    }
  }

  async deleteProviderImage(
    providerImageId: string,
    providerSessionId?: string | null,
    signal?: AbortSignal
  ): Promise<void> {
    if (!providerSessionId) return;
    try {
      await this.client.deleteCheckpoint(
        providerSessionId,
        providerImageId,
        ...(signal ? [signal] : [])
      );
    } catch (error) {
      if (error instanceof OpenComputerNotFoundError) return;
      throw this.classifyError("Failed to delete OpenComputer checkpoint", error);
    }
  }

  private async buildRuntimeEnvironment(
    config: CreateSandboxConfig | RestoreConfig,
    mode: {
      restoredFromSnapshot?: boolean;
      fromPrebuiltImage?: boolean;
      prebuiltImageSha?: string;
    } = {}
  ): Promise<PreparedOpenComputerEnvironment> {
    const { envVars: baseEnvVars, secretEnvVars } = this.prepareEnvironment(config.userEnvVars);
    const envVars = buildSandboxEnvVars(config, {
      baseEnvVars,
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

    if (mode.restoredFromSnapshot) envVars.RESTORED_FROM_SNAPSHOT = "true";
    if (mode.fromPrebuiltImage) {
      envVars.FROM_REPO_IMAGE = "true";
      envVars.REPO_IMAGE_SHA = mode.prebuiltImageSha ?? "";
      if (!envVars[VCS_CLONE_TOKEN_ENV_VAR]) {
        envVars[VCS_CLONE_TOKEN_ENV_VAR] = "";
      }
    }

    // OpenComputer forks (repo-image create + snapshot restore) inherit the
    // source sandbox's persisted env. Repo-image checkpoints are taken from a
    // build sandbox, so its build-mode markers — IMAGE_BUILD_MODE plus the
    // repo-image build-callback vars — and one-shot clone token leak into the
    // forked session unless we override them here, making the supervisor
    // re-enter image-build mode (booting "build" instead of "repo_image", then
    // failing the already-completed build-complete callback). A runtime session
    // is never an image build, so force the markers off. IMAGE_BUILD_MODE is
    // checked as === "true" in entrypoint.py, so "false" disables it.
    envVars[IMAGE_BUILD_MODE_ENV_VAR] = "false";
    for (const key of RESERVED_REPO_IMAGE_CALLBACK_ENV_KEYS) envVars[key] = "";

    return { envVars, secretEnvVars };
  }

  /**
   * Shared build-sandbox env assembly plus OpenComputer's callback overlay
   * and secret-store split. Unlike Vercel (which delivers callback env at
   * entrypoint launch), OpenComputer bakes the callback contract into the
   * sandbox env at create time; only the provider session id is delivered at
   * startRuntime.
   */
  private buildBuildEnvironment(
    config: ImageBuildProviderTriggerConfig,
    sandboxId: string
  ): PreparedOpenComputerEnvironment {
    const { envVars: baseEnvVars, secretEnvVars } = this.prepareEnvironment(config.userEnvVars, {
      scrubReservedRepoImageEnv: true,
    });
    const envVars = buildImageBuildEnvVars({
      sandboxId,
      repositories: config.repositories,
      scmIdentity: scmCloneIdentity(this.providerConfig.scmProvider),
      cloneToken: config.cloneToken,
      baseEnvVars,
    });

    Object.assign(
      envVars,
      // No providerSessionId: the sandbox does not exist yet at create time;
      // OpenComputer delivers the id separately at startRuntime.
      buildImageBuildCallbackEnv({
        buildId: config.buildId,
        callbackUrl: config.callbackUrl,
        failureCallbackUrl: config.failureCallbackUrl,
        token: config.callbackToken,
      }),
      { [IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_KEY]: String(config.buildExecutionTimeoutSeconds) }
    );

    return { envVars, secretEnvVars };
  }

  private prepareEnvironment(
    userEnvVars: Record<string, string> | undefined,
    options: { scrubReservedRepoImageEnv?: boolean } = {}
  ): PreparedOpenComputerEnvironment {
    const envVars: Record<string, string> = {};
    copyDefinedEnvVars(envVars, this.providerConfig.llmEnvVars);
    copyDefinedEnvVars(envVars, userEnvVars);

    const secretEnvVars = copyDefinedEnvVars({}, userEnvVars);
    for (const key of RESERVED_VNC_ENV_KEYS) {
      delete envVars[key];
      delete secretEnvVars[key];
    }
    if (options.scrubReservedRepoImageEnv) {
      for (const key of RESERVED_REPO_IMAGE_CALLBACK_ENV_KEYS) {
        delete envVars[key];
        delete secretEnvVars[key];
      }
    }

    return { envVars, secretEnvVars };
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

  /**
   * Build a unique secret-store name for a sandbox. The store is linked to its
   * sandbox by the name returned at creation and is never looked up by a
   * re-derived name, so the name only needs to be unique, not deterministic.
   *
   * Build ids are `img-<owner>-<repo>-<ts>`; a plain `id.slice(0, 32)` dropped
   * the unique timestamp, collapsing every build for a repo to one name — so
   * concurrent or sequential same-repo builds (and session re-spawns) collided
   * on create. Appending a random suffix keeps names unique, within the same
   * length budget, so no two stores ever share a name.
   */
  private buildSecretStoreName(id: string): string {
    return `openinspect-${id.slice(0, 23)}-${crypto.randomUUID().slice(0, 8)}`;
  }

  private buildCheckpointName(sessionId: string, reason: string): string {
    const safeReason = reason.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40) || "snapshot";
    return `openinspect-${sessionId.slice(0, 32)}-${safeReason}-${Date.now()}`;
  }

  private allowedHostsForSecret(name: string): string[] | undefined {
    const normalized = name.toUpperCase();
    if (normalized.includes("ANTHROPIC")) return ["api.anthropic.com"];
    if (normalized.includes("OPENAI")) return ["api.openai.com"];
    // VCS_CLONE_* is the provider-generic clone credential, so it follows the
    // configured SCM provider; GITHUB-named secrets are GitHub credentials no
    // matter which provider the deployment clones from.
    if (normalized.includes("VCS_CLONE")) {
      return [...scmCloneIdentity(this.providerConfig.scmProvider).secretHosts];
    }
    if (normalized.includes("GITHUB")) {
      return [...scmCloneIdentity("github").secretHosts];
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
      ...(config.repoOwner && config.repoName
        ? { openinspect_repo: `${config.repoOwner}/${config.repoName}` }
        : {}),
      openinspect_expected_sandbox_id: config.sandboxId,
    };
  }

  private async buildTunnelUrls(
    providerObjectId: string,
    logicalSandboxId: string,
    codeServerEnabled: boolean | undefined,
    vncEnabled: boolean | undefined,
    sandboxSettings: SandboxSettings | undefined,
    sandbox?: OpenComputerSandboxResponse
  ): Promise<{
    codeServerUrl?: string;
    codeServerPassword?: string;
    vncAccess?: VncAccess;
    tunnelUrls?: Record<string, string>;
  }> {
    const routeUrls = this.routeUrlsFromSandbox(sandbox);
    const { codeServerPort, vncPort } = resolveServicePorts(sandboxSettings);
    let tunnelPorts = resolveTunnelPorts(sandboxSettings?.tunnelPorts);
    let codeServerUrl: string | undefined;
    let codeServerPassword: string | undefined;
    let vncAccess: VncAccess | undefined;

    if (codeServerEnabled) {
      codeServerUrl =
        routeUrls[String(codeServerPort)] ??
        (await this.client.getTunnelUrl(providerObjectId, codeServerPort)).url;
      codeServerPassword = await deriveCodeServerPassword(
        logicalSandboxId,
        this.providerConfig.sandboxAccessPasswordSecret
      );
      tunnelPorts = tunnelPorts.filter((port) => port !== codeServerPort);
    }

    if (vncEnabled) {
      const url =
        routeUrls[String(vncPort)] ??
        (await this.client.getTunnelUrl(providerObjectId, vncPort)).url;
      const password = await deriveVncPassword(
        logicalSandboxId,
        this.providerConfig.sandboxAccessPasswordSecret
      );
      vncAccess = { url, password };
      tunnelPorts = tunnelPorts.filter((port) => port !== vncPort);
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

    return { codeServerUrl, codeServerPassword, vncAccess, tunnelUrls };
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

  private requireTemplate(): string {
    const template = this.client.config.template;
    if (!template) {
      throw new SandboxProviderError(
        "OPENCOMPUTER_TEMPLATE is required to create OpenComputer sandboxes",
        "permanent"
      );
    }
    return template;
  }
}

function copyDefinedEnvVars(
  target: Record<string, string>,
  source: Record<string, string | undefined> | undefined
): Record<string, string> {
  for (const [name, value] of Object.entries(source ?? {})) {
    if (value) target[name] = value;
  }
  return target;
}

export function createOpenComputerProvider(
  client: OpenComputerRestClient,
  providerConfig: OpenComputerProviderConfig
): OpenComputerSandboxProvider {
  return new OpenComputerSandboxProvider(client, providerConfig);
}
