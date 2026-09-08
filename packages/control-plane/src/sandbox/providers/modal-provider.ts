/**
 * Modal sandbox provider implementation.
 *
 * Wraps the existing ModalClient to implement the SandboxProvider interface,
 * enabling unit testing and future provider abstraction.
 */

import { ModalApiError } from "../client";
import type { ModalClient } from "../client";
import type { CorrelationContext } from "../../logger";
import {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  SandboxProviderError,
  createVncAccess,
  type ImageBuildProviderTriggerConfig,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type RestoreConfig,
  type RestoreResult,
  type SnapshotConfig,
  type SnapshotResult,
} from "../provider";

interface StartModalImageBuildConfig {
  buildId: string;
  providerSessionId: string;
  callbackToken: string;
  correlation?: CorrelationContext;
}

/** Modal extends the shared trigger contract with explicit SCM clone identity. */
export interface ModalImageBuildTriggerConfig extends ImageBuildProviderTriggerConfig {
  cloneHost?: string;
  cloneUsername?: string;
}

export interface TerminateModalImageBuildConfig {
  buildId: string;
  providerSessionId: string;
  reason: string;
  correlation?: CorrelationContext;
  signal?: AbortSignal;
}

export interface SnapshotModalImageBuildConfig {
  buildId: string;
  providerSessionId: string;
  correlation?: CorrelationContext;
  signal?: AbortSignal;
}

export interface ModalImageBuildProvider {
  triggerImageBuild(config: ModalImageBuildTriggerConfig): Promise<void>;
  terminateImageBuildSandbox(config: TerminateModalImageBuildConfig): Promise<void>;
  snapshotImageBuildSandbox(config: SnapshotModalImageBuildConfig): Promise<SnapshotResult>;
  deleteProviderImage(
    providerImageId: string,
    correlation?: CorrelationContext,
    signal?: AbortSignal
  ): Promise<void>;
}

/**
 * Modal sandbox provider.
 *
 * Implements the SandboxProvider interface using Modal's HTTP API.
 * All operations use HMAC-authenticated requests via the shared secret.
 *
 * @example
 * ```typescript
 * const client = createModalClient(secret, workspace, environmentWebSuffix);
 * const provider = new ModalSandboxProvider(client);
 *
 * try {
 *   const result = await provider.createSandbox(config);
 * } catch (e) {
 *   if (e instanceof SandboxProviderError && e.errorType === "permanent") {
 *     // Increment circuit breaker
 *   }
 * }
 * ```
 */
export class ModalSandboxProvider implements SandboxProvider, ModalImageBuildProvider {
  readonly name = "modal";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSandboxTimeout: true,
    supportsSnapshots: true,
    supportsRestore: true,
    supportsPersistentResume: false,
    supportsExplicitStop: false,
  };

  constructor(private readonly client: ModalClient) {}

  /**
   * Create a new sandbox via Modal API.
   */
  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    try {
      const result = await this.client.createSandbox(
        {
          sessionId: config.sessionId,
          sandboxId: config.sandboxId,
          repoOwner: config.repoOwner,
          repoName: config.repoName,
          controlPlaneUrl: config.controlPlaneUrl,
          sandboxAuthToken: config.sandboxAuthToken,
          opencodeSessionId: config.opencodeSessionId,
          provider: config.provider,
          model: config.model,
          userEnvVars: config.userEnvVars,
          prebuiltImageId: config.prebuiltImageId,
          prebuiltImageSha: config.prebuiltImageSha,
          timeoutSeconds: config.timeoutSeconds,
          branch: config.branch,
          codeServerEnabled: config.codeServerEnabled,
          vncEnabled: config.vncEnabled,
          agentSlackNotifyEnabled: config.agentSlackNotifyEnabled,
          mcpServers: config.mcpServers,
          sandboxSettings: config.sandboxSettings,
          repositories: config.repositories,
        },
        config.correlation
      );

      return {
        sandboxId: result.sandboxId,
        providerObjectId: result.modalObjectId,
        createdAt: result.createdAt,
        codeServerUrl: result.codeServerUrl,
        codeServerPassword: result.codeServerPassword,
        vncAccess: createVncAccess(result.vncUrl, result.vncPassword),
        ttydUrl: result.ttydUrl,
        tunnelUrls: result.tunnelUrls,
      };
    } catch (error) {
      throw this.classifyError("Failed to create sandbox", error);
    }
  }

  /**
   * Restore a sandbox from a filesystem snapshot.
   */
  async restoreFromSnapshot(config: RestoreConfig): Promise<RestoreResult> {
    try {
      const result = await this.client.restoreSandbox(
        {
          snapshotImageId: config.snapshotImageId,
          sessionId: config.sessionId,
          sandboxId: config.sandboxId,
          sandboxAuthToken: config.sandboxAuthToken,
          controlPlaneUrl: config.controlPlaneUrl,
          repoOwner: config.repoOwner,
          repoName: config.repoName,
          provider: config.provider,
          model: config.model,
          userEnvVars: config.userEnvVars,
          timeoutSeconds: config.timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS,
          branch: config.branch,
          codeServerEnabled: config.codeServerEnabled,
          vncEnabled: config.vncEnabled,
          agentSlackNotifyEnabled: config.agentSlackNotifyEnabled,
          mcpServers: config.mcpServers,
          sandboxSettings: config.sandboxSettings,
          repositories: config.repositories,
        },
        config.correlation
      );

      if (result.success) {
        return {
          success: true,
          sandboxId: result.sandboxId,
          providerObjectId: result.modalObjectId,
          codeServerUrl: result.codeServerUrl,
          codeServerPassword: result.codeServerPassword,
          vncAccess: createVncAccess(result.vncUrl, result.vncPassword),
          ttydUrl: result.ttydUrl,
          tunnelUrls: result.tunnelUrls,
        };
      }

      return {
        success: false,
        error: result.error || "Unknown restore error",
      };
    } catch (error) {
      if (error instanceof ModalApiError) {
        throw this.classifyErrorWithStatus(
          `Restore failed with HTTP ${error.status}`,
          error.status
        );
      }
      if (error instanceof SandboxProviderError) {
        throw error;
      }
      throw this.classifyError("Failed to restore sandbox from snapshot", error);
    }
  }

  /**
   * Take a filesystem snapshot of the sandbox.
   */
  async takeSnapshot(config: SnapshotConfig): Promise<SnapshotResult> {
    try {
      const result = await this.client.snapshotSandbox(
        {
          providerObjectId: config.providerObjectId,
          sessionId: config.sessionId,
          signal: config.signal,
        },
        config.correlation
      );

      if (result.success && result.imageId) {
        return {
          success: true,
          imageId: result.imageId,
        };
      }

      return {
        success: false,
        error: result.error || "Unknown snapshot error",
      };
    } catch (error) {
      if (error instanceof ModalApiError) {
        throw this.classifyErrorWithStatus(
          `Snapshot failed with HTTP ${error.status}: ${error.message}`,
          error.status,
          error
        );
      }
      if (error instanceof SandboxProviderError) {
        throw error;
      }
      throw this.classifyError("Failed to take snapshot", error);
    }
  }

  async snapshotImageBuildSandbox(config: SnapshotModalImageBuildConfig): Promise<SnapshotResult> {
    try {
      const result = await this.client.snapshotBuildSandbox(
        {
          buildId: config.buildId,
          providerSessionId: config.providerSessionId,
          ...(config.signal ? { signal: config.signal } : {}),
        },
        config.correlation
      );
      if (result.success && result.imageId) {
        return { success: true, imageId: result.imageId };
      }
      return {
        success: false,
        error: result.error || "Unknown image build snapshot error",
      };
    } catch (error) {
      if (error instanceof ModalApiError) {
        throw this.classifyErrorWithStatus(
          `Image build snapshot failed with HTTP ${error.status}`,
          error.status,
          error
        );
      }
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to snapshot image build sandbox", error);
    }
  }

  private async createImageBuildSandbox(
    config: ModalImageBuildTriggerConfig
  ): Promise<{ providerSessionId: string }> {
    try {
      return await this.client.createImageBuildSandbox(
        {
          scopeKind: config.scopeKind,
          scopeId: config.scopeId,
          buildId: config.buildId,
          repositories: config.repositories,
          cloneToken: config.cloneToken,
          ...(config.cloneHost ? { cloneHost: config.cloneHost } : {}),
          ...(config.cloneUsername ? { cloneUsername: config.cloneUsername } : {}),
          callbackUrl: config.callbackUrl,
          failureCallbackUrl: config.failureCallbackUrl,
          userEnvVars: config.userEnvVars,
          buildExecutionTimeoutSeconds: config.buildExecutionTimeoutSeconds,
          providerSessionTimeoutSeconds: config.providerSessionTimeoutSeconds,
        },
        config.correlation
      );
    } catch (error) {
      throw this.classifyImageBuildError("Failed to create Modal image build sandbox", error);
    }
  }

  private async startImageBuildSandbox(config: StartModalImageBuildConfig): Promise<void> {
    try {
      await this.client.startImageBuildSandbox(config, config.correlation);
    } catch (error) {
      throw this.classifyImageBuildError("Failed to start Modal image build sandbox", error);
    }
  }

  async triggerImageBuild(config: ModalImageBuildTriggerConfig): Promise<void> {
    const created = await this.createImageBuildSandbox(config);
    await config.onProviderSessionCreated(created.providerSessionId);
    await this.startImageBuildSandbox({
      buildId: config.buildId,
      providerSessionId: created.providerSessionId,
      callbackToken: config.callbackToken,
      correlation: config.correlation,
    });
  }

  async terminateImageBuildSandbox(config: TerminateModalImageBuildConfig): Promise<void> {
    try {
      await this.client.terminateImageBuildSandbox(config, config.correlation);
    } catch (error) {
      throw this.classifyImageBuildError("Failed to terminate Modal image build sandbox", error);
    }
  }

  /**
   * Deletion is a local no-op for now: Modal's only deletion surface is the
   * experimental `image_delete` API, whose adoption is deferred until
   * validated (#1658). The HTTP endpoint this replaced deleted nothing
   * either, so reaped images were already retained provider-side. Callers
   * (the image reaper and finalizer) log each attempt and outcome.
   */
  async deleteProviderImage(): Promise<void> {}

  private classifyImageBuildError(message: string, error: unknown): SandboxProviderError {
    if (error instanceof SandboxProviderError) return error;
    if (error instanceof ModalApiError) {
      return this.classifyErrorWithStatus(
        `${message} with HTTP ${error.status}: ${error.message}`,
        error.status,
        error
      );
    }
    return this.classifyError(message, error);
  }

  /**
   * Classify an error based on HTTP status code.
   * Uses status code directly for accurate transient/permanent classification.
   */
  private classifyErrorWithStatus(
    message: string,
    status: number,
    cause?: Error
  ): SandboxProviderError {
    // Transient: 502, 503, 504 (gateway/availability issues)
    if (status === 502 || status === 503 || status === 504) {
      return new SandboxProviderError(message, "transient", cause);
    }

    // Permanent: 4xx (client errors) and other 5xx (server errors)
    return new SandboxProviderError(message, "permanent", cause);
  }

  /**
   * Classify an error as transient or permanent for circuit breaker handling.
   */
  private classifyError(message: string, error: unknown): SandboxProviderError {
    if (SandboxProviderError.isTransientNetworkError(error)) {
      return new SandboxProviderError(
        `${message}: ${error instanceof Error ? error.message : String(error)}`,
        "transient",
        error instanceof Error ? error : undefined
      );
    }

    // Check for fetch/network errors
    if (error instanceof Error) {
      const errorMessage = error.message.toLowerCase();

      // Transient network errors
      if (
        errorMessage.includes("502") ||
        errorMessage.includes("503") ||
        errorMessage.includes("504") ||
        errorMessage.includes("bad gateway") ||
        errorMessage.includes("service unavailable") ||
        errorMessage.includes("gateway timeout")
      ) {
        return new SandboxProviderError(`${message}: ${error.message}`, "transient", error);
      }
    }

    // Default to permanent for unknown errors (config issues, auth failures, etc.)
    return new SandboxProviderError(
      `${message}: ${error instanceof Error ? error.message : String(error)}`,
      "permanent",
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Create a Modal sandbox provider.
 *
 * @param client - ModalClient instance for API calls
 * @returns ModalSandboxProvider instance
 */
export function createModalProvider(client: ModalClient): ModalSandboxProvider {
  return new ModalSandboxProvider(client);
}
