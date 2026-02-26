/**
 * Modal sandbox provider implementation.
 *
 * Wraps the existing ModalClient to implement the SandboxProvider interface,
 * enabling unit testing and future provider abstraction.
 */

import { generateInternalToken } from "@open-inspect/shared";
import type { ModalClient } from "../client";
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
 * Modal sandbox provider.
 *
 * Implements the SandboxProvider interface using Modal's HTTP API.
 * All operations use HMAC-authenticated requests via the shared secret.
 *
 * @example
 * ```typescript
 * const client = createModalClient(secret, workspace);
 * const provider = new ModalSandboxProvider(client, secret);
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
export class ModalSandboxProvider implements SandboxProvider {
  readonly name = "modal";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSnapshots: true,
    supportsRestore: true,
    supportsWarm: true,
  };

  constructor(
    private readonly client: ModalClient,
    private readonly secret: string
  ) {}

  /**
   * Create a new sandbox via Modal API.
   */
  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    try {
      const result = await this.client.createSandbox({
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
        branch: config.branch,
      });

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
      const restoreUrl = this.client.getRestoreSandboxUrl();
      const authToken = await generateInternalToken(this.secret);

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      };
      if (config.traceId) headers["x-trace-id"] = config.traceId;
      if (config.requestId) headers["x-request-id"] = config.requestId;

      const response = await fetch(restoreUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          snapshot_image_id: config.snapshotImageId,
          session_config: {
            session_id: config.sessionId,
            repo_owner: config.repoOwner,
            repo_name: config.repoName,
            provider: config.provider,
            model: config.model,
            branch: config.branch || null,
          },
          sandbox_id: config.sandboxId,
          control_plane_url: config.controlPlaneUrl,
          sandbox_auth_token: config.sandboxAuthToken,
          user_env_vars: config.userEnvVars || null,
          timeout_seconds: config.timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS,
        }),
      });

      // Check HTTP status before parsing JSON
      if (!response.ok) {
        throw this.classifyErrorWithStatus(
          `Restore failed with HTTP ${response.status}`,
          response.status
        );
      }

      const result = (await response.json()) as {
        success: boolean;
        data?: { sandbox_id: string; modal_object_id?: string };
        error?: string;
      };

      if (result.success) {
        return {
          success: true,
          sandboxId: result.data?.sandbox_id,
          providerObjectId: result.data?.modal_object_id,
        };
      }

      return {
        success: false,
        error: result.error || "Unknown restore error",
      };
    } catch (error) {
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
      const snapshotUrl = this.client.getSnapshotSandboxUrl();
      const authToken = await generateInternalToken(this.secret);

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      };
      if (config.traceId) headers["x-trace-id"] = config.traceId;
      if (config.requestId) headers["x-request-id"] = config.requestId;

      const response = await fetch(snapshotUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          sandbox_id: config.providerObjectId, // Modal's internal object ID
          session_id: config.sessionId,
          reason: config.reason,
        }),
      });

      // Check HTTP status before parsing JSON
      if (!response.ok) {
        throw this.classifyErrorWithStatus(
          `Snapshot failed with HTTP ${response.status}`,
          response.status
        );
      }

      const result = (await response.json()) as {
        success: boolean;
        data?: { image_id: string };
        error?: string;
      };

      if (result.success && result.data?.image_id) {
        return {
          success: true,
          imageId: result.data.image_id,
        };
      }

      return {
        success: false,
        error: result.error || "Unknown snapshot error",
      };
    } catch (error) {
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
 * Create a Modal sandbox provider.
 *
 * @param client - ModalClient instance for API calls
 * @param secret - MODAL_API_SECRET for authentication
 * @returns ModalSandboxProvider instance
 */
export function createModalProvider(client: ModalClient, secret: string): ModalSandboxProvider {
  return new ModalSandboxProvider(client, secret);
}
