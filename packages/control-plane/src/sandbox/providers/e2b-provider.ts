/**
 * E2B sandbox provider — calls the E2B REST API directly.
 *
 * Stop is a resumable pause (like Daytona's stop), so the shared lifecycle
 * manager's persistent-resume path drives idle-pause and resume with no
 * E2B-specific plumbing. Sandboxes are created with auto-pause + auto-resume so
 * a lapsed TTL pauses (recoverable) rather than kills, and inbound activity
 * wakes it. Per-session env is delivered via an envd file write because the
 * template's start command runs at build time.
 */

import type { SandboxSettings } from "@open-inspect/shared";
import { createLogger } from "../../logger";
import { buildSandboxEnvVars, deriveCodeServerPassword } from "./e2b-helpers";
import { resolveServicePorts, resolveTunnelPorts } from "./port-resolution";
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

/** Sandbox TTL default. Hobby plans (~1h cap) should lower this via config. */
export const DEFAULT_E2B_SANDBOX_TIMEOUT_SECONDS = DEFAULT_SANDBOX_TIMEOUT_SECONDS;
/** Default to a recoverable stop: pause (and auto-resume) on timeout, not kill. */
export const DEFAULT_E2B_AUTO_PAUSE = true;

export interface E2BProviderConfig {
  scmProvider: SourceControlProviderName;
  codeServerPasswordSecret: string;
  sandboxTimeoutSeconds: number;
  /**
   * Pause (not kill) when the sandbox TTL expires, so it stays resumable, and
   * auto-resume it on inbound activity. Auto-resume tracks this flag — there's
   * no reason to pause without it.
   */
  autoPause: boolean;
}

export class E2BSandboxProvider implements SandboxProvider {
  readonly name = "e2b";

  /**
   * Stop reasons that are terminal (the manager sets the session `failed` and
   * never resumes it) — kill instead of pausing to avoid orphaning a sandbox.
   */
  private static readonly TERMINAL_STOP_REASONS = new Set(["connecting_timeout"]);

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSnapshots: false,
    supportsRestore: false,
    // Stop is a resumable pause; the manager treats it as provider-managed state.
    supportsPersistentResume: true,
    supportsExplicitStop: true,
  };

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
        autoPause: this.providerConfig.autoPause,
        // Auto-resume tracks auto-pause: a recoverable pause you can't auto-wake
        // would be pointless.
        autoResume: this.providerConfig.autoPause,
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
      try {
        if (sandbox.state === "paused") {
          await this.client.connectSandbox(config.providerObjectId, timeoutSeconds);
        } else if (sandbox.state === "running") {
          await this.client.setSandboxTimeout(config.providerObjectId, timeoutSeconds);
        } else {
          return {
            success: false,
            error: `Sandbox in non-resumable state: ${sandbox.state}`,
            shouldSpawnFresh: true,
          };
        }
      } catch (error) {
        // The sandbox can disappear between the GET above and this call — treat a
        // late 404 the same as an initial one so the manager spawns fresh.
        if (error instanceof E2BNotFoundError) {
          return {
            success: false,
            error: "Sandbox no longer exists in E2B",
            shouldSpawnFresh: true,
          };
        }
        throw error;
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

  /**
   * Idle/heartbeat stops are a resumable PAUSE (the manager routes them here via
   * supportsPersistentResume, and resumeSandbox brings the sandbox back).
   * Terminal stops (a sandbox that never connected) instead KILL: the manager
   * marks that session `failed` and won't resume it, so pausing would orphan a
   * sandbox E2B retains indefinitely.
   */
  async stopSandbox(config: StopConfig): Promise<StopResult> {
    const terminal = E2BSandboxProvider.TERMINAL_STOP_REASONS.has(config.reason);
    try {
      try {
        if (terminal) {
          await this.client.killSandbox(config.providerObjectId);
        } else {
          await this.client.pauseSandbox(config.providerObjectId);
        }
      } catch (error) {
        // Already gone or already paused — nothing to do.
        if (error instanceof E2BNotFoundError || error instanceof E2BConflictError) {
          return { success: true };
        }
        throw error;
      }
      return { success: true };
    } catch (error) {
      throw this.classifyError(
        `Failed to stop (${terminal ? "kill" : "pause"}) E2B sandbox`,
        error,
        "stop"
      );
    }
  }

  private buildMetadata(config: CreateSandboxConfig): Record<string, string> {
    const metadata: Record<string, string> = {
      openinspect_framework: "open-inspect",
      openinspect_session_id: config.sessionId,
      openinspect_expected_sandbox_id: config.sandboxId,
    };
    // Repo-less (environment/multi-repo) sessions have no single repo to label.
    if (config.repoOwner && config.repoName) {
      metadata.openinspect_repo = `${config.repoOwner}/${config.repoName}`;
    }
    return metadata;
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
      const { codeServerPort } = resolveServicePorts(sandboxSettings);
      codeServerUrl = this.client.getHostnameForPort(e2bSandboxId, codeServerPort, domain);
      tunnelPorts = tunnelPorts.filter((p) => p !== codeServerPort);
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
    operation: "create" | "resume" | "stop"
  ): SandboxProviderError {
    if (error instanceof E2BApiError) {
      if (error.status === 429) {
        // Rate limiting is temporary — classify transient so it isn't counted
        // toward the sandbox circuit breaker (a permanent error would open the
        // breaker and block later spawns for minutes).
        return new SandboxProviderError(
          `${message} (rate-limited during ${operation})`,
          "transient",
          error
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
