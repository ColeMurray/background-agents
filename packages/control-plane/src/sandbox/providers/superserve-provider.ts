/** Superserve sandbox provider backed by the control-plane and data-plane REST APIs. */

import { computeHmacHex, type SandboxSettings } from "@open-inspect/shared";
import { createLogger } from "../../logger";
import type { SourceControlProviderName } from "../../source-control";
import {
  SuperserveApiError,
  SuperserveNotFoundError,
  type SuperserveRestClient,
} from "../superserve-rest-client";
import { buildSessionConfig } from "../sandbox-env";
import {
  SandboxProviderError,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type ResumeConfig,
  type ResumeResult,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type StopConfig,
  type StopResult,
} from "../provider";
import { resolveServicePorts, resolveTunnelPorts } from "./port-resolution";

const log = createLogger("superserve-provider");
const EXPECTED_TUNNEL_PORTS_ENV_VAR = "EXPECTED_TUNNEL_PORTS";

export interface SuperserveProviderConfig {
  scmProvider: SourceControlProviderName;
  /** Secret used for deterministic code-server password derivation. */
  codeServerPasswordSecret: string;
  /** Provider-level LLM credentials made available to the runtime. */
  llmEnvVars?: Record<string, string | undefined>;
}

interface SuperserveSandboxAccess {
  codeServerUrl?: string;
  codeServerPassword?: string;
  ttydUrl?: string;
  tunnelUrls?: Record<string, string>;
}

export class SuperserveSandboxProvider implements SandboxProvider {
  readonly name = "superserve";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSnapshots: false,
    supportsRestore: false,
    supportsPersistentResume: true,
    supportsExplicitStop: true,
  };

  constructor(
    private readonly client: SuperserveRestClient,
    private readonly providerConfig: SuperserveProviderConfig
  ) {}

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    let providerObjectId: string | undefined;
    try {
      const envVars = await this.buildEnvVars(config);
      const sandbox = await this.client.createSandbox({
        name: config.sandboxId,
        envVars,
        metadata: this.buildMetadata(config),
        timeoutSeconds: config.timeoutSeconds,
      });
      providerObjectId = sandbox.id;
      if (!providerObjectId || !sandbox.access_token) {
        throw new SuperserveApiError(
          "Superserve create response was missing id or access_token",
          502
        );
      }

      const access = await this.buildSandboxAccess(
        providerObjectId,
        config.sandboxId,
        config.codeServerEnabled,
        config.sandboxSettings
      );
      await this.client.startRuntime(
        providerObjectId,
        sandbox.access_token,
        envVars,
        access.tunnelUrls
      );

      return {
        sandboxId: config.sandboxId,
        providerObjectId,
        status: sandbox.status || "active",
        createdAt: parseCreatedAt(sandbox.created_at),
        codeServerUrl: access.codeServerUrl,
        codeServerPassword: access.codeServerPassword,
        ttydUrl: access.ttydUrl,
        tunnelUrls: access.tunnelUrls,
      };
    } catch (error) {
      if (providerObjectId) {
        try {
          await this.client.deleteSandbox(providerObjectId);
        } catch (cleanupError) {
          log.warn("superserve.sandbox_cleanup_failed", {
            session_id: config.sessionId,
            provider_object_id: providerObjectId,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      }
      throw this.classifyError("Failed to create Superserve sandbox", error);
    }
  }

  async resumeSandbox(config: ResumeConfig): Promise<ResumeResult> {
    try {
      let sandbox;
      try {
        sandbox = await this.client.activateSandbox(config.providerObjectId);
      } catch (error) {
        if (error instanceof SuperserveNotFoundError) {
          return {
            success: false,
            error: "Sandbox no longer exists in Superserve",
            shouldSpawnFresh: true,
          };
        }
        throw error;
      }

      if (!sandbox.access_token) {
        throw new SuperserveApiError("Superserve activate response was missing access_token", 502);
      }

      let access: SuperserveSandboxAccess = {};
      try {
        access = await this.buildSandboxAccess(
          config.providerObjectId,
          config.sandboxId,
          config.codeServerEnabled,
          config.sandboxSettings
        );
      } catch (error) {
        log.warn("superserve.resume_tunnel_urls_failed", {
          sandbox_id: config.sandboxId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      await this.client.startRuntime(
        config.providerObjectId,
        sandbox.access_token,
        { SANDBOX_ID: config.sandboxId },
        access.tunnelUrls
      );

      return {
        success: true,
        providerObjectId: sandbox.id || config.providerObjectId,
        codeServerUrl: access.codeServerUrl,
        codeServerPassword: access.codeServerPassword,
        tunnelUrls: access.tunnelUrls,
      };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to resume Superserve sandbox", error);
    }
  }

  async stopSandbox(config: StopConfig): Promise<StopResult> {
    try {
      try {
        await this.client.pauseSandbox(config.providerObjectId);
      } catch (error) {
        if (error instanceof SuperserveNotFoundError) return { success: true };
        throw error;
      }
      return { success: true };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to pause Superserve sandbox", error);
    }
  }

  private async buildEnvVars(config: CreateSandboxConfig): Promise<Record<string, string>> {
    const envVars: Record<string, string> = {};
    copyDefinedEnvVars(envVars, this.providerConfig.llmEnvVars);
    copyDefinedEnvVars(envVars, config.userEnvVars);

    Object.assign(envVars, {
      HOME: "/root",
      NODE_ENV: "development",
      PYTHONPATH: "/app",
      PYTHONUNBUFFERED: "1",
      NODE_PATH: "/usr/lib/node_modules:/usr/local/lib/node_modules",
      SANDBOX_ID: config.sandboxId,
      CONTROL_PLANE_URL: config.controlPlaneUrl,
      SANDBOX_AUTH_TOKEN: config.sandboxAuthToken,
      REPO_OWNER: config.repoOwner ?? "",
      REPO_NAME: config.repoName ?? "",
      SESSION_CONFIG: JSON.stringify(buildSessionConfig(config)),
    });

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

    const extraTunnelPorts = collectExtraTunnelPorts(
      config.codeServerEnabled,
      config.sandboxSettings
    );
    if (extraTunnelPorts.length > 0) {
      envVars[EXPECTED_TUNNEL_PORTS_ENV_VAR] = extraTunnelPorts.join(",");
    }

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

    return envVars;
  }

  private buildMetadata(config: CreateSandboxConfig): Record<string, string> {
    return {
      openinspect_framework: "open-inspect",
      openinspect_provider: "superserve",
      openinspect_session_id: config.sessionId,
      openinspect_expected_sandbox_id: config.sandboxId,
      ...(config.repoOwner && config.repoName
        ? { openinspect_repo: `${config.repoOwner}/${config.repoName}` }
        : {}),
    };
  }

  private async buildSandboxAccess(
    providerObjectId: string,
    logicalSandboxId: string,
    codeServerEnabled: boolean | undefined,
    sandboxSettings: SandboxSettings | undefined
  ): Promise<SuperserveSandboxAccess> {
    const { codeServerPort, terminalPort } = resolveServicePorts(sandboxSettings);
    const extraTunnelPorts = collectExtraTunnelPorts(codeServerEnabled, sandboxSettings);
    const tunnelUrls =
      extraTunnelPorts.length > 0
        ? Object.fromEntries(
            extraTunnelPorts.map((port) => [
              String(port),
              this.client.getPreviewUrl(providerObjectId, port),
            ])
          )
        : undefined;

    return {
      codeServerUrl: codeServerEnabled
        ? this.client.getPreviewUrl(providerObjectId, codeServerPort)
        : undefined,
      codeServerPassword: codeServerEnabled
        ? await this.deriveCodeServerPassword(logicalSandboxId)
        : undefined,
      ttydUrl: sandboxSettings?.terminalEnabled
        ? this.client.getPreviewUrl(providerObjectId, terminalPort)
        : undefined,
      tunnelUrls,
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
    if (error instanceof SuperserveApiError) {
      return SandboxProviderError.fromFetchError(
        `${message}: ${error.message}`,
        error,
        error.status
      );
    }
    return SandboxProviderError.fromFetchError(message, error);
  }
}

function collectExtraTunnelPorts(
  codeServerEnabled: boolean | undefined,
  sandboxSettings: SandboxSettings | undefined
): number[] {
  const { codeServerPort, terminalPort } = resolveServicePorts(sandboxSettings);
  const reserved = new Set<number>();
  if (codeServerEnabled) reserved.add(codeServerPort);
  if (sandboxSettings?.terminalEnabled) reserved.add(terminalPort);
  return resolveTunnelPorts(sandboxSettings?.tunnelPorts).filter((port) => !reserved.has(port));
}

function copyDefinedEnvVars(
  target: Record<string, string>,
  source: Record<string, string | undefined> | undefined
): void {
  if (!source) return;
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) target[key] = value;
  }
}

function parseCreatedAt(value: string | undefined): number {
  if (!value) return Date.now();
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

export function createSuperserveProvider(
  client: SuperserveRestClient,
  providerConfig: SuperserveProviderConfig
): SuperserveSandboxProvider {
  return new SuperserveSandboxProvider(client, providerConfig);
}
