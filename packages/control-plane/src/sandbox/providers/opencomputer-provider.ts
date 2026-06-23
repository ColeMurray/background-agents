/**
 * OpenComputer sandbox provider.
 *
 * Uses an OpenComputer declarative template that already contains the
 * OpenInspect sandbox runtime. Stop maps to hibernate, and resume maps to wake.
 */

import { computeHmacHex, type SandboxSettings } from "@open-inspect/shared";
import { resolveServicePorts, resolveTunnelPorts } from "./port-resolution";
import { createLogger } from "../../logger";
import type { SourceControlProviderName } from "../../source-control";
import {
  OpenComputerApiError,
  OpenComputerNotFoundError,
  type OpenComputerRestClient,
  type OpenComputerCreateSandboxParams,
  type OpenComputerSandboxResponse,
  type OpenComputerSecretStoreResponse,
} from "../opencomputer-rest-client";
import { buildSessionConfig } from "../sandbox-env";
import {
  SandboxProviderError,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  type ResumeConfig,
  type ResumeResult,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type StopConfig,
  type StopResult,
} from "../provider";

const log = createLogger("opencomputer-provider");
const OPENCOMPUTER_SECRET_STORE_EGRESS_ALLOWLIST = ["*"];

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
    supportsSnapshots: false,
    supportsRestore: false,
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
    try {
      const envVars = await this.buildRuntimeEnvVars(config);
      secretStore = await this.createSessionSecretStore(config);
      const params: OpenComputerCreateSandboxParams = {
        name: config.sandboxId,
        template: this.client.config.template,
        env: envVars,
        labels: this.buildLabels(config),
        timeoutSeconds: config.timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS,
        secretStore: secretStore?.name,
        projectId: this.client.config.projectId,
        target: this.client.config.target,
      };

      const sandbox = await this.client.createSandbox(params);
      const providerObjectId = sandbox.id;
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

  private async buildRuntimeEnvVars(config: CreateSandboxConfig): Promise<Record<string, string>> {
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
      REPO_OWNER: config.repoOwner,
      REPO_NAME: config.repoName,
      SESSION_CONFIG: JSON.stringify(sessionConfig),
    });

    if (config.codeServerEnabled) {
      envVars.CODE_SERVER_PASSWORD = await this.deriveCodeServerPassword(config.sandboxId);
      envVars.CODE_SERVER_PORT = String(resolveServicePorts(config.sandboxSettings).codeServerPort);
    }

    if (config.agentSlackNotifyEnabled) {
      envVars.AGENT_SLACK_NOTIFY_ENABLED = "true";
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

  private async createSessionSecretStore(
    config: CreateSandboxConfig
  ): Promise<OpenComputerSecretStoreResponse> {
    const userEnvVars = config.userEnvVars ?? {};
    const entries = Object.entries(userEnvVars).filter(([, value]) => value.length > 0);

    const store = await this.client.createSecretStore({
      name: this.buildSecretStoreName(config.sessionId),
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
          session_id: config.sessionId,
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

  private allowedHostsForSecret(name: string): string[] | undefined {
    const normalized = name.toUpperCase();
    if (normalized.includes("ANTHROPIC")) return ["api.anthropic.com"];
    if (normalized.includes("OPENAI")) return ["api.openai.com"];
    if (normalized.includes("GITHUB") || normalized.includes("VCS_CLONE")) {
      return ["github.com", "api.github.com"];
    }
    return undefined;
  }

  private buildLabels(config: CreateSandboxConfig): Record<string, string> {
    return {
      openinspect_framework: "open-inspect",
      openinspect_provider: "opencomputer",
      openinspect_session_id: config.sessionId,
      openinspect_repo: `${config.repoOwner}/${config.repoName}`,
      openinspect_expected_sandbox_id: config.sandboxId,
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
            routeUrls[String(port)] ??
            (await this.client.getTunnelUrl(providerObjectId, port)).url;
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

export function createOpenComputerProvider(
  client: OpenComputerRestClient,
  providerConfig: OpenComputerProviderConfig
): OpenComputerSandboxProvider {
  return new OpenComputerSandboxProvider(client, providerConfig);
}
