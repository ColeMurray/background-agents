/**
 * Daytona sandbox provider — calls the Daytona REST API directly.
 *
 * Ports env-var assembly, label construction, tunnel-URL generation, and
 * code-server password derivation that previously lived in the Python shim.
 */

import type { SandboxSettings } from "@open-inspect/shared";
import { resolveServicePorts, resolveTunnelPorts } from "./port-resolution";
import { createLogger } from "../../logger";
import type { SourceControlProviderName } from "../../source-control";
import type { DaytonaRestClient, DaytonaCreateSandboxParams } from "../daytona-rest-client";
import { DaytonaApiError, DaytonaNotFoundError } from "../daytona-rest-client";
import {
  buildSandboxEnvVars,
  deriveCodeServerPassword,
  legacyScmCloneIdentity,
} from "../sandbox-env";
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

const log = createLogger("daytona-provider");

// ---------------------------------------------------------------------------
// Constants (ported from packages/daytona-infra/src/config.py)
// ---------------------------------------------------------------------------

const DEFAULT_PREVIEW_EXPIRY_SECONDS = 3900;

// ---------------------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------------------

export interface DaytonaProviderConfig {
  scmProvider: SourceControlProviderName;
  gitlabAccessToken?: string;
  /** Secret used for HMAC derivation of code-server passwords */
  codeServerPasswordSecret: string;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class DaytonaSandboxProvider implements SandboxProvider {
  readonly name = "daytona";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSnapshots: false,
    supportsRestore: false,
    supportsPersistentResume: true,
    supportsExplicitStop: true,
  };

  constructor(
    private readonly client: DaytonaRestClient,
    private readonly providerConfig: DaytonaProviderConfig
  ) {}

  // -----------------------------------------------------------------------
  // SandboxProvider interface
  // -----------------------------------------------------------------------

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    try {
      const envVars = await this.buildEnvVars(config);
      const labels = this.buildLabels(config);

      const params: DaytonaCreateSandboxParams = {
        name: config.sandboxId,
        snapshot: this.client.config.baseSnapshot,
        env: envVars,
        labels,
        autoStopInterval: this.client.config.autoStopIntervalMinutes,
        autoArchiveInterval: this.client.config.autoArchiveIntervalMinutes,
        public: false,
      };
      if (this.client.config.target) {
        params.target = this.client.config.target;
      }

      const sandbox = await this.client.createSandbox(params);

      const { codeServerUrl, codeServerPassword, tunnelUrls } = await this.buildTunnelUrls(
        sandbox.id,
        config.sandboxId,
        config.timeoutSeconds,
        config.codeServerEnabled,
        config.sandboxSettings
      );

      return {
        sandboxId: config.sandboxId,
        providerObjectId: sandbox.id,
        status: sandbox.state,
        createdAt: Date.now(),
        codeServerUrl,
        codeServerPassword,
        tunnelUrls,
      };
    } catch (error) {
      throw this.classifyError("Failed to create Daytona sandbox", error);
    }
  }

  async resumeSandbox(config: ResumeConfig): Promise<ResumeResult> {
    try {
      let sandbox;
      try {
        sandbox = await this.client.getSandbox(config.providerObjectId);
      } catch (error) {
        if (error instanceof DaytonaNotFoundError) {
          return {
            success: false,
            error: "Sandbox no longer exists in Daytona",
            shouldSpawnFresh: true,
          };
        }
        throw error;
      }

      const state = sandbox.state;
      if ((state === "error" || state === "build_failed") && sandbox.recoverable) {
        await this.client.recoverSandbox(config.providerObjectId);
      } else if (state !== "started") {
        // Covers stopped, archived, and non-recoverable error states —
        // Daytona's start endpoint handles the state transition internally.
        await this.client.startSandbox(config.providerObjectId);
      }

      // Tunnel URL generation runs after start so a preview-URL failure
      // doesn't mask a successful resume.
      let codeServerUrl: string | undefined;
      let codeServerPassword: string | undefined;
      let tunnelUrls: Record<string, string> | undefined;
      try {
        const tunnels = await this.buildTunnelUrls(
          config.providerObjectId,
          config.sandboxId,
          config.timeoutSeconds,
          config.codeServerEnabled,
          config.sandboxSettings
        );
        codeServerUrl = tunnels.codeServerUrl;
        codeServerPassword = tunnels.codeServerPassword;
        tunnelUrls = tunnels.tunnelUrls;
      } catch (tunnelError) {
        log.warn("daytona.resume_tunnel_urls_failed", {
          sandbox_id: config.sandboxId,
          error: tunnelError instanceof Error ? tunnelError.message : String(tunnelError),
        });
      }

      return {
        success: true,
        providerObjectId: sandbox.id,
        codeServerUrl,
        codeServerPassword,
        tunnelUrls,
      };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to resume Daytona sandbox", error);
    }
  }

  async stopSandbox(config: StopConfig): Promise<StopResult> {
    try {
      try {
        await this.client.stopSandbox(config.providerObjectId);
      } catch (error) {
        if (error instanceof DaytonaNotFoundError) {
          return { success: true };
        }
        throw error;
      }
      return { success: true };
    } catch (error) {
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to stop Daytona sandbox", error);
    }
  }

  // -----------------------------------------------------------------------
  // Env var assembly (ported from service.py _build_env)
  // -----------------------------------------------------------------------

  private async buildEnvVars(config: CreateSandboxConfig): Promise<Record<string, string>> {
    return buildSandboxEnvVars(config, {
      scmIdentity: legacyScmCloneIdentity(this.providerConfig.scmProvider),
      codeServerPassword: config.codeServerEnabled
        ? await deriveCodeServerPassword(
            config.sandboxId,
            this.providerConfig.codeServerPasswordSecret
          )
        : undefined,
    });
  }

  // -----------------------------------------------------------------------
  // Label assembly (ported from service.py _build_labels)
  // -----------------------------------------------------------------------

  private buildLabels(config: CreateSandboxConfig): Record<string, string> {
    return {
      openinspect_framework: "open-inspect",
      openinspect_session_id: config.sessionId,
      openinspect_expected_sandbox_id: config.sandboxId,
      ...(config.repoOwner && config.repoName
        ? { openinspect_repo: `${config.repoOwner}/${config.repoName}` }
        : {}),
    };
  }

  // -----------------------------------------------------------------------
  // Tunnel URL generation (ported from service.py _build_tunnel_urls)
  // -----------------------------------------------------------------------

  private async buildTunnelUrls(
    daytonaSandboxId: string,
    logicalSandboxId: string,
    timeoutSeconds: number | undefined,
    codeServerEnabled: boolean | undefined,
    sandboxSettings: SandboxSettings | undefined
  ): Promise<{
    codeServerUrl?: string;
    codeServerPassword?: string;
    tunnelUrls?: Record<string, string>;
  }> {
    const expirySeconds = resolvePreviewExpirySeconds(timeoutSeconds);
    const { codeServerPort } = resolveServicePorts(sandboxSettings);
    let tunnelPorts = resolveTunnelPorts(sandboxSettings?.tunnelPorts);
    let codeServerUrl: string | undefined;
    let codeServerPassword: string | undefined;

    if (codeServerEnabled) {
      const preview = await this.client.getSignedPreviewUrl(
        daytonaSandboxId,
        codeServerPort,
        expirySeconds
      );
      codeServerUrl = preview.url;
      codeServerPassword = await deriveCodeServerPassword(
        logicalSandboxId,
        this.providerConfig.codeServerPasswordSecret
      );
      tunnelPorts = tunnelPorts.filter((p) => p !== codeServerPort);
    }

    let tunnelUrls: Record<string, string> | undefined;
    if (tunnelPorts.length > 0) {
      const entries = await Promise.all(
        tunnelPorts.map(async (port) => {
          const preview = await this.client.getSignedPreviewUrl(
            daytonaSandboxId,
            port,
            expirySeconds
          );
          return [String(port), preview.url] as const;
        })
      );
      tunnelUrls = Object.fromEntries(entries);
    }

    return { codeServerUrl, codeServerPassword, tunnelUrls };
  }

  // -----------------------------------------------------------------------
  // Error classification
  // -----------------------------------------------------------------------

  private classifyError(message: string, error: unknown): SandboxProviderError {
    if (error instanceof DaytonaApiError) {
      return SandboxProviderError.fromFetchError(
        `${message}: ${error.message}`,
        error,
        error.status
      );
    }
    return SandboxProviderError.fromFetchError(message, error);
  }
}

// ---------------------------------------------------------------------------
// Helpers (ported from config.py)
// ---------------------------------------------------------------------------

function resolvePreviewExpirySeconds(timeoutSeconds: number | undefined): number {
  if (!timeoutSeconds) return DEFAULT_PREVIEW_EXPIRY_SECONDS;
  return Math.min(86400, Math.max(900, timeoutSeconds + 300));
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDaytonaProvider(
  client: DaytonaRestClient,
  providerConfig: DaytonaProviderConfig
): DaytonaSandboxProvider {
  return new DaytonaSandboxProvider(client, providerConfig);
}
