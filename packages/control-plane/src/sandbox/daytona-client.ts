/**
 * Daytona sandbox API client.
 *
 * Provides methods to interact with Daytona sandboxes from the control plane.
 * All requests are authenticated using HMAC-signed tokens.
 *
 * Pattern-matches the ModalClient interface so providers can use either backend.
 */

import { generateInternalToken } from "@open-inspect/shared";
import { createLogger } from "../logger";
import type { CorrelationContext } from "../logger";
import type {
  CreateSandboxRequest,
  CreateSandboxResponse,
  RestoreSandboxRequest,
  RestoreSandboxResponse,
  SnapshotSandboxRequest,
  SnapshotSandboxResponse,
  WarmSandboxRequest,
  WarmSandboxResponse,
  BuildRepoImageRequest,
  BuildRepoImageResponse,
  DeleteProviderImageRequest,
  DeleteProviderImageResponse,
  SnapshotInfo,
} from "./client";

const log = createLogger("daytona-client");

/**
 * Error thrown by DaytonaClient when the Daytona API returns a non-OK HTTP status.
 * Carries the numeric status code so callers can classify without string parsing.
 */
export class DaytonaApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "DaytonaApiError";
  }
}

interface DaytonaApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Generate authentication headers for POST/PUT requests (includes Content-Type).
 */
async function getPostHeaders(
  secret: string,
  correlation?: CorrelationContext
): Promise<Record<string, string>> {
  const token = await generateInternalToken(secret);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  if (correlation?.trace_id) headers["x-trace-id"] = correlation.trace_id;
  if (correlation?.request_id) headers["x-request-id"] = correlation.request_id;
  if (correlation?.session_id) headers["x-session-id"] = correlation.session_id;
  if (correlation?.sandbox_id) headers["x-sandbox-id"] = correlation.sandbox_id;
  return headers;
}

/**
 * Generate authentication headers for GET requests (no Content-Type).
 */
async function getGetHeaders(
  secret: string,
  correlation?: CorrelationContext
): Promise<Record<string, string>> {
  const token = await generateInternalToken(secret);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (correlation?.trace_id) headers["x-trace-id"] = correlation.trace_id;
  if (correlation?.request_id) headers["x-request-id"] = correlation.request_id;
  if (correlation?.session_id) headers["x-session-id"] = correlation.session_id;
  if (correlation?.sandbox_id) headers["x-sandbox-id"] = correlation.sandbox_id;
  return headers;
}

/**
 * Daytona sandbox API client.
 *
 * Implements the same interface as ModalClient so providers can use either backend.
 * Requires DAYTONA_API_SECRET for authentication and DAYTONA_API_URL for the base URL.
 */
export class DaytonaClient {
  private createSandboxUrl: string;
  private warmSandboxUrl: string;
  private healthUrl: string;
  private snapshotUrl: string;
  private snapshotSandboxUrl: string;
  private restoreSandboxUrl: string;
  private buildRepoImageUrl: string;
  private deleteProviderImageUrl: string;
  private secret: string;

  constructor(secret: string, baseUrl: string) {
    if (!secret) {
      throw new Error("DaytonaClient requires DAYTONA_API_SECRET for authentication");
    }
    if (!baseUrl) {
      throw new Error("DaytonaClient requires DAYTONA_API_URL for URL construction");
    }
    this.secret = secret;
    this.createSandboxUrl = `${baseUrl}/api/create-sandbox`;
    this.warmSandboxUrl = `${baseUrl}/api/warm-sandbox`;
    this.healthUrl = `${baseUrl}/api/health`;
    this.snapshotUrl = `${baseUrl}/api/snapshot`;
    this.snapshotSandboxUrl = `${baseUrl}/api/snapshot-sandbox`;
    this.restoreSandboxUrl = `${baseUrl}/api/restore-sandbox`;
    this.buildRepoImageUrl = `${baseUrl}/api/build-repo-image`;
    this.deleteProviderImageUrl = `${baseUrl}/api/delete-provider-image`;
  }

  /**
   * Create a new sandbox for a session.
   */
  async createSandbox(
    request: CreateSandboxRequest,
    correlation?: CorrelationContext
  ): Promise<CreateSandboxResponse> {
    const startTime = Date.now();
    const endpoint = "createSandbox";
    let httpStatus: number | undefined;
    let outcome: "success" | "error" = "error";

    try {
      const headers = await getPostHeaders(this.secret, correlation);
      const response = await fetch(this.createSandboxUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          session_id: request.sessionId,
          sandbox_id: request.sandboxId || null,
          repo_owner: request.repoOwner,
          repo_name: request.repoName,
          control_plane_url: request.controlPlaneUrl,
          sandbox_auth_token: request.sandboxAuthToken,
          snapshot_id: request.snapshotId || null,
          opencode_session_id: request.opencodeSessionId || null,
          provider: request.provider || "anthropic",
          model: request.model || "claude-sonnet-4-6",
          user_env_vars: request.userEnvVars || null,
          repo_image_id: request.repoImageId || null,
          repo_image_sha: request.repoImageSha || null,
          timeout_seconds: request.timeoutSeconds || null,
          branch: request.branch || null,
        }),
      });

      httpStatus = response.status;

      if (!response.ok) {
        const text = await response.text();
        throw new DaytonaApiError(`Daytona API error: ${response.status} ${text}`, response.status);
      }

      const result = (await response.json()) as DaytonaApiResponse<{
        sandbox_id: string;
        provider_object_id?: string;
        status: string;
        created_at: number;
      }>;

      if (!result.success || !result.data) {
        throw new Error(`Daytona API error: ${result.error || "Unknown error"}`);
      }

      outcome = "success";
      return {
        sandboxId: result.data.sandbox_id,
        // Daytona returns provider_object_id; map to modalObjectId for interface compat
        modalObjectId: result.data.provider_object_id,
        status: result.data.status,
        createdAt: result.data.created_at,
      };
    } finally {
      log.info("daytona.request", {
        event: "daytona.request",
        endpoint,
        session_id: request.sessionId,
        sandbox_id: request.sandboxId,
        trace_id: correlation?.trace_id,
        request_id: correlation?.request_id,
        http_status: httpStatus,
        duration_ms: Date.now() - startTime,
        outcome,
      });
    }
  }

  /**
   * Restore a sandbox from a snapshot image.
   */
  async restoreSandbox(
    request: RestoreSandboxRequest,
    correlation?: CorrelationContext
  ): Promise<RestoreSandboxResponse> {
    const startTime = Date.now();
    const endpoint = "restoreSandbox";
    let httpStatus: number | undefined;
    let outcome: "success" | "error" = "error";

    try {
      const headers = await getPostHeaders(this.secret, correlation);
      const response = await fetch(this.restoreSandboxUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          snapshot_image_id: request.snapshotImageId,
          session_config: {
            session_id: request.sessionId,
            repo_owner: request.repoOwner,
            repo_name: request.repoName,
            provider: request.provider,
            model: request.model,
            branch: request.branch || null,
          },
          sandbox_id: request.sandboxId,
          control_plane_url: request.controlPlaneUrl,
          sandbox_auth_token: request.sandboxAuthToken,
          user_env_vars: request.userEnvVars || null,
          timeout_seconds: request.timeoutSeconds || null,
        }),
      });

      httpStatus = response.status;

      if (!response.ok) {
        const text = await response.text();
        throw new DaytonaApiError(`Daytona API error: ${response.status} ${text}`, response.status);
      }

      const result = (await response.json()) as DaytonaApiResponse<{
        sandbox_id: string;
        provider_object_id?: string;
      }>;

      if (!result.success) {
        return { success: false, error: result.error || "Unknown restore error" };
      }

      outcome = "success";
      return {
        success: true,
        sandboxId: result.data?.sandbox_id,
        // Daytona returns provider_object_id; map to modalObjectId for interface compat
        modalObjectId: result.data?.provider_object_id,
      };
    } finally {
      log.info("daytona.request", {
        event: "daytona.request",
        endpoint,
        session_id: request.sessionId,
        sandbox_id: request.sandboxId,
        trace_id: correlation?.trace_id,
        request_id: correlation?.request_id,
        http_status: httpStatus,
        duration_ms: Date.now() - startTime,
        outcome,
      });
    }
  }

  /**
   * Trigger a filesystem snapshot for a sandbox object.
   */
  async snapshotSandbox(
    request: SnapshotSandboxRequest,
    correlation?: CorrelationContext
  ): Promise<SnapshotSandboxResponse> {
    const startTime = Date.now();
    const endpoint = "snapshotSandbox";
    let httpStatus: number | undefined;
    let outcome: "success" | "error" = "error";

    try {
      const headers = await getPostHeaders(this.secret, correlation);
      const response = await fetch(this.snapshotSandboxUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          sandbox_id: request.providerObjectId,
          session_id: request.sessionId,
          reason: request.reason,
        }),
      });

      httpStatus = response.status;

      if (!response.ok) {
        const text = await response.text();
        throw new DaytonaApiError(`Daytona API error: ${response.status} ${text}`, response.status);
      }

      const result = (await response.json()) as DaytonaApiResponse<{ image_id: string }>;
      if (!result.success) {
        return { success: false, error: result.error || "Unknown snapshot error" };
      }

      if (!result.data?.image_id) {
        return { success: false, error: "Snapshot response missing image_id" };
      }

      outcome = "success";
      return { success: true, imageId: result.data.image_id };
    } finally {
      log.info("daytona.request", {
        event: "daytona.request",
        endpoint,
        session_id: request.sessionId,
        sandbox_id: request.providerObjectId,
        trace_id: correlation?.trace_id,
        request_id: correlation?.request_id,
        http_status: httpStatus,
        duration_ms: Date.now() - startTime,
        outcome,
      });
    }
  }

  /**
   * Pre-warm a sandbox for faster startup.
   */
  async warmSandbox(
    request: WarmSandboxRequest,
    correlation?: CorrelationContext
  ): Promise<WarmSandboxResponse> {
    const startTime = Date.now();
    const endpoint = "warmSandbox";
    let httpStatus: number | undefined;
    let outcome: "success" | "error" = "error";

    try {
      const headers = await getPostHeaders(this.secret, correlation);
      const response = await fetch(this.warmSandboxUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          repo_owner: request.repoOwner,
          repo_name: request.repoName,
          control_plane_url: request.controlPlaneUrl || "",
        }),
      });

      httpStatus = response.status;

      if (!response.ok) {
        const text = await response.text();
        throw new DaytonaApiError(`Daytona API error: ${response.status} ${text}`, response.status);
      }

      const result = (await response.json()) as DaytonaApiResponse<{
        sandbox_id: string;
        status: string;
      }>;

      if (!result.success || !result.data) {
        throw new Error(`Daytona API error: ${result.error || "Unknown error"}`);
      }

      outcome = "success";
      return {
        sandboxId: result.data.sandbox_id,
        status: result.data.status,
      };
    } finally {
      log.info("daytona.request", {
        event: "daytona.request",
        endpoint,
        repo_owner: request.repoOwner,
        repo_name: request.repoName,
        trace_id: correlation?.trace_id,
        request_id: correlation?.request_id,
        http_status: httpStatus,
        duration_ms: Date.now() - startTime,
        outcome,
      });
    }
  }

  /**
   * Check Daytona API health.
   */
  async health(): Promise<{ status: string; service: string }> {
    const response = await fetch(this.healthUrl);

    if (!response.ok) {
      throw new DaytonaApiError(`Daytona API error: ${response.status}`, response.status);
    }

    const result = (await response.json()) as DaytonaApiResponse<{
      status: string;
      service: string;
    }>;

    if (!result.success || !result.data) {
      throw new Error(`Daytona API error: ${result.error || "Unknown error"}`);
    }

    return result.data;
  }

  /**
   * Get the latest snapshot for a repository.
   */
  async getLatestSnapshot(
    repoOwner: string,
    repoName: string,
    correlation?: CorrelationContext
  ): Promise<SnapshotInfo | null> {
    const url = `${this.snapshotUrl}?repo_owner=${encodeURIComponent(repoOwner)}&repo_name=${encodeURIComponent(repoName)}`;

    const headers = await getGetHeaders(this.secret, correlation);
    const response = await fetch(url, { headers });

    if (!response.ok) {
      return null;
    }

    const result = (await response.json()) as DaytonaApiResponse<SnapshotInfo>;

    if (!result.success) {
      return null;
    }

    return result.data || null;
  }

  /**
   * Trigger an async image build on Daytona.
   */
  async buildRepoImage(
    request: BuildRepoImageRequest,
    correlation?: CorrelationContext
  ): Promise<BuildRepoImageResponse> {
    const startTime = Date.now();
    const endpoint = "buildRepoImage";
    let httpStatus: number | undefined;
    let outcome: "success" | "error" = "error";

    try {
      const headers = await getPostHeaders(this.secret, correlation);
      const response = await fetch(this.buildRepoImageUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          repo_owner: request.repoOwner,
          repo_name: request.repoName,
          default_branch: request.defaultBranch || "main",
          build_id: request.buildId,
          callback_url: request.callbackUrl,
          user_env_vars: request.userEnvVars,
        }),
      });

      httpStatus = response.status;

      if (!response.ok) {
        const text = await response.text();
        throw new DaytonaApiError(`Daytona API error: ${response.status} ${text}`, response.status);
      }

      const result = (await response.json()) as DaytonaApiResponse<{
        build_id: string;
        status: string;
      }>;

      if (!result.success || !result.data) {
        throw new Error(`Daytona API error: ${result.error || "Unknown error"}`);
      }

      outcome = "success";
      return {
        buildId: result.data.build_id,
        status: result.data.status,
      };
    } finally {
      log.info("daytona.request", {
        event: "daytona.request",
        endpoint,
        build_id: request.buildId,
        repo_owner: request.repoOwner,
        repo_name: request.repoName,
        trace_id: correlation?.trace_id,
        request_id: correlation?.request_id,
        http_status: httpStatus,
        duration_ms: Date.now() - startTime,
        outcome,
      });
    }
  }

  /**
   * Delete a provider image (best-effort).
   */
  async deleteProviderImage(
    request: DeleteProviderImageRequest,
    correlation?: CorrelationContext
  ): Promise<DeleteProviderImageResponse> {
    const startTime = Date.now();
    const endpoint = "deleteProviderImage";
    let httpStatus: number | undefined;
    let outcome: "success" | "error" = "error";

    try {
      const headers = await getPostHeaders(this.secret, correlation);
      const response = await fetch(this.deleteProviderImageUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          provider_image_id: request.providerImageId,
        }),
      });

      httpStatus = response.status;

      if (!response.ok) {
        const text = await response.text();
        throw new DaytonaApiError(`Daytona API error: ${response.status} ${text}`, response.status);
      }

      const result = (await response.json()) as DaytonaApiResponse<{
        provider_image_id: string;
        deleted: boolean;
      }>;

      if (!result.success || !result.data) {
        throw new Error(`Daytona API error: ${result.error || "Unknown error"}`);
      }

      outcome = "success";
      return {
        providerImageId: result.data.provider_image_id,
        deleted: result.data.deleted,
      };
    } finally {
      log.info("daytona.request", {
        event: "daytona.request",
        endpoint,
        provider_image_id: request.providerImageId,
        trace_id: correlation?.trace_id,
        request_id: correlation?.request_id,
        http_status: httpStatus,
        duration_ms: Date.now() - startTime,
        outcome,
      });
    }
  }
}

/**
 * Create a new Daytona client instance.
 *
 * @param secret - The DAYTONA_API_SECRET for authentication
 * @param baseUrl - The Daytona infra API base URL
 * @returns A new DaytonaClient instance
 * @throws Error if secret or baseUrl is not provided
 */
export function createDaytonaClient(secret: string, baseUrl: string): DaytonaClient {
  if (!secret) {
    throw new Error("DAYTONA_API_SECRET is required to create DaytonaClient");
  }
  if (!baseUrl) {
    throw new Error("DAYTONA_API_URL is required to create DaytonaClient");
  }
  return new DaytonaClient(secret, baseUrl);
}
