/**
 * E2B sandbox provider — calls the E2B REST API directly.
 *
 * Mirrors the Daytona provider shape.
 */

import type { SandboxSettings } from "@open-inspect/shared";
import { createLogger } from "../../logger";
import { buildSandboxEnvVars, deriveCodeServerPassword, resolveTunnelPorts } from "./helpers";
import type { SourceControlProviderName } from "../../source-control";
import type { E2BRestClient, E2BSandboxDetail } from "../e2b-rest-client";
import { E2BApiError, E2BConflictError, E2BNotFoundError } from "../e2b-rest-client";
import {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
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

const log = createLogger("e2b-provider");
const CODE_SERVER_PORT = 8080;

// Defaults assume a PAID E2B plan (long runtime limits): the system-wide
// sandbox TTL and runtime-cap cycling disabled. Hobby (~1h TTL + continuous-
// runtime caps the API cannot report) must override both via env:
// E2B_SANDBOX_TIMEOUT_SECONDS=3300, E2B_RUNTIME_CAP_SECONDS=3300.
export const DEFAULT_E2B_SANDBOX_TIMEOUT_SECONDS = DEFAULT_SANDBOX_TIMEOUT_SECONDS;
export const DEFAULT_E2B_RUNTIME_CAP_SECONDS = 0;
const MAX_ACTIVITY_REFRESH_INTERVAL_MS = 300_000;
/** E2B caps a single TTL refresh/`timeout` at one hour. */
const E2B_MAX_TTL_SECONDS = 3600;

export interface E2BProviderConfig {
  scmProvider: SourceControlProviderName;
  gitlabAccessToken?: string;
  codeServerPasswordSecret: string;
  sandboxTimeoutSeconds: number;
  runtimeCapSeconds: number;
}

export class E2BSandboxProvider implements SandboxProvider {
  readonly name = "e2b";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSnapshots: false,
    supportsRestore: false,
    supportsPersistentResume: true,
    supportsExplicitStop: true,
  };

  private readonly lastActivityRefreshMs = new Map<string, number>();

  constructor(
    private readonly client: E2BRestClient,
    private readonly providerConfig: E2BProviderConfig
  ) {}

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    try {
      const codeServerPassword = config.codeServerEnabled
        ? await deriveCodeServerPassword(
            config.sandboxId,
            this.providerConfig.codeServerPasswordSecret
          )
        : undefined;
      const envVars = buildSandboxEnvVars(config, {
        scmProvider: this.providerConfig.scmProvider,
        codeServerPassword,
      });
      const metadata = this.buildMetadata(config);
      const sandbox = await this.client.createSandbox({
        templateID: this.client.config.templateId,
        metadata,
        timeout: config.timeoutSeconds ?? this.providerConfig.sandboxTimeoutSeconds,
        autoPause: false,
      });

      try {
        // Deliver per-session env to the supervisor. E2B's template start command
        // runs once at build and never sees create-time env vars, so the launcher
        // (oi-launch.py) waits for this file and execs the supervisor with it.
        await this.client.writeSessionEnv(sandbox.sandboxID, envVars, {
          domain: sandbox.domain,
          envdAccessToken: sandbox.envdAccessToken,
        });
      } catch (error) {
        // The sandbox exists but will never get its session env — kill it rather
        // than leak a running launcher-only sandbox until its TTL.
        try {
          await this.client.killSandbox(sandbox.sandboxID);
        } catch (killError) {
          log.warn("e2b.cleanup_kill_failed", {
            sandbox_id: sandbox.sandboxID,
            error: killError instanceof Error ? killError.message : String(killError),
          });
        }
        throw error;
      }

      const { codeServerUrl, tunnelUrls } = this.buildTunnelUrls(
        sandbox.sandboxID,
        config.codeServerEnabled,
        config.sandboxSettings,
        sandbox.domain
      );

      return {
        sandboxId: config.sandboxId,
        providerObjectId: sandbox.sandboxID,
        status: "running",
        createdAt: Date.now(),
        codeServerUrl,
        codeServerPassword,
        tunnelUrls,
      };
    } catch (error) {
      throw this.classifyError("Failed to create E2B sandbox", error, "create");
    }
  }

  async pauseSandbox(config: StopConfig): Promise<StopResult> {
    try {
      try {
        await this.client.pauseSandbox(config.providerObjectId);
      } catch (error) {
        if (error instanceof E2BNotFoundError || error instanceof E2BConflictError) {
          return { success: true };
        }
        throw error;
      }
      return { success: true };
    } catch (error) {
      throw this.classifyError("Failed to pause E2B sandbox", error, "pause");
    }
  }

  async resumeSandbox(config: ResumeConfig): Promise<ResumeResult> {
    try {
      let sandbox: E2BSandboxDetail;
      try {
        sandbox = await this.client.getSandbox(config.providerObjectId);
      } catch (error) {
        if (error instanceof E2BNotFoundError) {
          return {
            success: false,
            error: "Sandbox no longer exists in E2B",
            shouldSpawnFresh: true,
          };
        }
        throw error;
      }

      const timeoutSeconds = config.timeoutSeconds ?? this.providerConfig.sandboxTimeoutSeconds;
      if (sandbox.state === "paused") {
        await this.client.connectSandbox(config.providerObjectId, timeoutSeconds);
      } else if (sandbox.state === "running") {
        await this.client.setTimeout(config.providerObjectId, timeoutSeconds);
      } else {
        return {
          success: false,
          error: `Sandbox in non-resumable state: ${sandbox.state}`,
          shouldSpawnFresh: true,
        };
      }

      const codeServerPassword = config.codeServerEnabled
        ? await deriveCodeServerPassword(
            config.sandboxId,
            this.providerConfig.codeServerPasswordSecret
          )
        : undefined;
      const { codeServerUrl, tunnelUrls } = this.buildTunnelUrls(
        config.providerObjectId,
        config.codeServerEnabled,
        config.sandboxSettings,
        sandbox.domain
      );

      return {
        success: true,
        providerObjectId: sandbox.sandboxID,
        codeServerUrl,
        codeServerPassword,
        tunnelUrls,
      };
    } catch (error) {
      throw this.classifyError("Failed to resume E2B sandbox", error, "resume");
    }
  }

  async stopSandbox(config: StopConfig): Promise<StopResult> {
    this.lastActivityRefreshMs.delete(config.providerObjectId);
    try {
      try {
        await this.client.killSandbox(config.providerObjectId);
      } catch (error) {
        if (error instanceof E2BNotFoundError) return { success: true };
        throw error;
      }
      return { success: true };
    } catch (error) {
      throw this.classifyError("Failed to stop E2B sandbox", error, "kill");
    }
  }

  async onUserActivity(config: { providerObjectId: string; sessionId: string }): Promise<void> {
    const nowMs = Date.now();
    const throttleMs = Math.min(
      (this.providerConfig.sandboxTimeoutSeconds * 1000) / 4,
      MAX_ACTIVITY_REFRESH_INTERVAL_MS
    );
    const lastMs = this.lastActivityRefreshMs.get(config.providerObjectId) ?? 0;
    if (nowMs - lastMs < throttleMs) return;

    try {
      if (this.providerConfig.sandboxTimeoutSeconds > E2B_MAX_TTL_SECONDS) {
        await this.client.setTimeout(
          config.providerObjectId,
          this.providerConfig.sandboxTimeoutSeconds
        );
      } else {
        await this.client.refreshKeepalive(
          config.providerObjectId,
          Math.min(this.providerConfig.sandboxTimeoutSeconds, E2B_MAX_TTL_SECONDS)
        );
      }
      this.lastActivityRefreshMs.set(config.providerObjectId, nowMs);
    } catch (error) {
      log.warn("e2b.on_user_activity_failed", {
        provider_object_id: config.providerObjectId,
        session_id: config.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async shouldResetRuntime(config: {
    providerObjectId: string;
    startedAtMs: number;
    nowMs: number;
  }): Promise<{ shouldReset: boolean }> {
    // The continuous-runtime cap is an E2B *plan* limit (~1h on Hobby), not an
    // API constant, and the API exposes no way to query the plan — so it's
    // operator-configured. 0 disables cycling for plans without a meaningful
    // cap (e.g. Pro's 24h), where a 55-min pause/resume would be pure overhead.
    if (this.providerConfig.runtimeCapSeconds <= 0) {
      return { shouldReset: false };
    }
    const elapsedSeconds = (config.nowMs - config.startedAtMs) / 1000;
    return { shouldReset: elapsedSeconds >= this.providerConfig.runtimeCapSeconds };
  }

  private buildMetadata(config: CreateSandboxConfig): Record<string, string> {
    return {
      openinspect_framework: "open-inspect",
      openinspect_session_id: config.sessionId,
      openinspect_repo: `${config.repoOwner ?? ""}/${config.repoName ?? ""}`,
      openinspect_expected_sandbox_id: config.sandboxId,
    };
  }

  private buildTunnelUrls(
    e2bSandboxId: string,
    codeServerEnabled: boolean | undefined,
    sandboxSettings: SandboxSettings | undefined,
    domain?: string | null
  ) {
    let tunnelPorts = resolveTunnelPorts(sandboxSettings?.tunnelPorts);
    let codeServerUrl: string | undefined;

    if (codeServerEnabled) {
      codeServerUrl = this.client.getHostnameForPort(e2bSandboxId, CODE_SERVER_PORT, domain);
      tunnelPorts = tunnelPorts.filter((p) => p !== CODE_SERVER_PORT);
    }

    const tunnelUrls =
      tunnelPorts.length > 0
        ? Object.fromEntries(
            tunnelPorts.map((p) => [
              String(p),
              this.client.getHostnameForPort(e2bSandboxId, p, domain),
            ])
          )
        : undefined;

    return { codeServerUrl, tunnelUrls };
  }

  private classifyError(
    message: string,
    error: unknown,
    operation: "create" | "resume" | "pause" | "kill"
  ): SandboxProviderError {
    if (error instanceof E2BApiError) {
      if (error.status === 429) {
        return SandboxProviderError.fromFetchError(
          `${message} (rate-limited or quota exceeded during ${operation})`,
          error,
          error.status
        );
      }
      return SandboxProviderError.fromFetchError(
        `${message}: ${error.message}`,
        error,
        error.status
      );
    }
    return SandboxProviderError.fromFetchError(message, error);
  }
}

export function createE2BProvider(
  client: E2BRestClient,
  providerConfig: E2BProviderConfig
): E2BSandboxProvider {
  return new E2BSandboxProvider(client, providerConfig);
}
