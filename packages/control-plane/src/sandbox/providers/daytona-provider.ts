/**
 * Daytona sandbox provider implementation.
 *
 * Wraps the DaytonaClient to implement the SandboxProvider interface,
 * enabling use as a drop-in alternative to the Modal provider.
 */

import { DaytonaApiError } from "../daytona-client";
import type { DaytonaClient } from "../daytona-client";
import {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  SandboxProviderError,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type RestoreConfig,
  type RestoreResult,
  type SnapshotConfig,
  type SnapshotResult,
} from "../provider";

/**
 * Daytona sandbox provider.
 *
 * Implements the SandboxProvider interface using the Daytona HTTP API.
 * All operations use HMAC-authenticated requests via the shared secret.
 *
 * @example
 * ```typescript
 * const client = createDaytonaClient(secret, baseUrl);
 * const provider = new DaytonaSandboxProvider(client);
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
export class DaytonaSandboxProvider implements SandboxProvider {
  readonly name = "daytona";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSnapshots: true,
    supportsRestore: true,
    supportsWarm: true,
  };

  constructor(private readonly client: DaytonaClient) {}

  /**
   * Create a new sandbox via Daytona API.
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
          repoImageId: config.repoImageId,
          repoImageSha: config.repoImageSha,
          timeoutSeconds: config.timeoutSeconds,
          branch: config.branch,
        },
        config.correlation
      );

      return {
        sandboxId: result.sandboxId,
        providerObjectId: result.modalObjectId,
        status: result.status,
        createdAt: result.createdAt,
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
        },
        config.correlation
      );

      if (result.success) {
        return {
          success: true,
          sandboxId: result.sandboxId,
          providerObjectId: result.modalObjectId,
        };
      }

      return {
        success: false,
        error: result.error || "Unknown restore error",
      };
    } catch (error) {
      if (error instanceof DaytonaApiError) {
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
          reason: config.reason,
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
      if (error instanceof DaytonaApiError) {
        throw this.classifyErrorWithStatus(
          `Snapshot failed with HTTP ${error.status}`,
          error.status
        );
      }
      if (error instanceof SandboxProviderError) {
        throw error;
      }
      throw this.classifyError("Failed to take snapshot", error);
    }
  }

  /**
   * Classify an error based on HTTP status code.
   * Uses status code directly for accurate transient/permanent classification.
   */
  private classifyErrorWithStatus(message: string, status: number): SandboxProviderError {
    // Transient: 502, 503, 504 (gateway/availability issues)
    if (status === 502 || status === 503 || status === 504) {
      return new SandboxProviderError(message, "transient");
    }

    // Permanent: 4xx (client errors) and other 5xx (server errors)
    return new SandboxProviderError(message, "permanent");
  }

  /**
   * Classify an error as transient or permanent for circuit breaker handling.
   */
  private classifyError(message: string, error: unknown): SandboxProviderError {
    // Check for fetch/network errors
    if (error instanceof Error) {
      const errorMessage = error.message.toLowerCase();

      // Transient network errors
      if (
        errorMessage.includes("fetch failed") ||
        errorMessage.includes("etimedout") ||
        errorMessage.includes("econnreset") ||
        errorMessage.includes("econnrefused") ||
        errorMessage.includes("network") ||
        errorMessage.includes("timeout") ||
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
 * Create a Daytona sandbox provider.
 *
 * @param client - DaytonaClient instance for API calls
 * @returns DaytonaSandboxProvider instance
 */
export function createDaytonaProvider(client: DaytonaClient): DaytonaSandboxProvider {
  return new DaytonaSandboxProvider(client);
}
