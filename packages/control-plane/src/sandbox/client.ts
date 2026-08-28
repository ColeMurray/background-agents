/**
 * Modal sandbox API client.
 *
 * Provides methods to interact with Modal sandboxes from the control plane.
 * All requests are authenticated using HMAC-signed tokens.
 */

import { generateInternalToken } from "@open-inspect/shared/auth";
import type { ImageBuildScopeKind } from "@open-inspect/shared/types/image-builds";
import type { McpServerConfig, SandboxSettings } from "@open-inspect/shared/types/integrations";
import { z } from "zod";
import { createLogger } from "../logger";
import type { CorrelationContext } from "../logger";
import { buildSessionConfig, toRepositoryConfigPayload } from "./sandbox-env";
import type { SessionRepositoryInfo } from "./provider";
import { withRequestDeadline } from "./request-deadline";

const log = createLogger("modal-client");

// Modal app name
const MODAL_APP_NAME = "open-inspect";

// Modal's default environment name; unrelated to the git branch named "main".
const DEFAULT_MODAL_ENVIRONMENT = "main";

export const MODAL_SANDBOX_START_REQUEST_DEADLINE_MS = 60_000;
// Allows Modal's provider-side snapshot timeout to settle before the client deadline.
export const MODAL_SNAPSHOT_REQUEST_DEADLINE_MS = 310_000;
export const MODAL_CLEANUP_REQUEST_DEADLINE_MS = 60_000;

const modalErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.string().optional(),
});

const modalTunnelUrlsSchema = z.record(z.string(), z.string());

const createSandboxModalResponseSchema = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
    data: z.object({
      sandbox_id: z.string(),
      modal_object_id: z.string().nullable().optional(),
      created_at: z.number(),
      code_server_url: z.string().nullable().optional(),
      code_server_password: z.string().nullable().optional(),
      vnc_url: z.string().nullable().optional(),
      vnc_password: z.string().nullable().optional(),
      ttyd_url: z.string().nullable().optional(),
      tunnel_urls: modalTunnelUrlsSchema.nullable().optional(),
    }),
  }),
  modalErrorResponseSchema,
]);

const restoreSandboxModalResponseSchema = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
    data: z
      .object({
        sandbox_id: z.string().optional(),
        modal_object_id: z.string().nullable().optional(),
        code_server_url: z.string().nullable().optional(),
        code_server_password: z.string().nullable().optional(),
        vnc_url: z.string().nullable().optional(),
        vnc_password: z.string().nullable().optional(),
        ttyd_url: z.string().nullable().optional(),
        tunnel_urls: modalTunnelUrlsSchema.nullable().optional(),
      })
      .optional(),
  }),
  modalErrorResponseSchema,
]);

const snapshotSandboxModalResponseSchema = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
    data: z
      .object({
        image_id: z.string(),
      })
      .optional(),
  }),
  modalErrorResponseSchema,
]);

const createImageBuildSandboxModalResponseSchema = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
    data: z.object({
      // Non-empty: the previous hand-rolled check rejected a blank id.
      provider_session_id: z.string().min(1),
    }),
  }),
  modalErrorResponseSchema,
]);

/**
 * Image-build operations (start/terminate) only signal success or failure; their
 * `data` payload is never read, so it is deliberately left unvalidated.
 */
const imageBuildOperationModalResponseSchema = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
  }),
  modalErrorResponseSchema,
]);

function parseModalApiResponse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new Error("Modal API error: Invalid response");
  }
  return result.data;
}

/**
 * Build the Modal endpoint workspace slug from the raw workspace and environment web suffix.
 */
export function buildModalWorkspaceSlug(workspace: string, environmentWebSuffix = ""): string {
  return environmentWebSuffix === "" ? workspace : `${workspace}-${environmentWebSuffix}`;
}

/**
 * Construct the Modal base URL from workspace and environment web suffix.
 */
function getModalBaseUrl(workspace: string, environmentWebSuffix?: string): string {
  return `https://${buildModalWorkspaceSlug(workspace, environmentWebSuffix)}--${MODAL_APP_NAME}`;
}

/**
 * Build a Modal dashboard link for a sandbox object.
 */
export function buildModalSandboxDashboardUrl(params: {
  workspace: string | undefined;
  // Modal workspace environment (unrelated to the Environment entity); named
  // modalEnvironment to keep the term unambiguous (design §7.1).
  modalEnvironment?: string | undefined;
  providerObjectId: string | null | undefined;
}): string | null {
  if (!params.workspace || !params.providerObjectId) return null;
  const workspace = encodeURIComponent(params.workspace);
  const modalEnvironment = encodeURIComponent(params.modalEnvironment || DEFAULT_MODAL_ENVIRONMENT);
  const providerObjectId = encodeURIComponent(params.providerObjectId);
  return `https://modal.com/apps/${workspace}/${modalEnvironment}/deployed/${MODAL_APP_NAME}?activeTab=sandboxes&sandboxId=${providerObjectId}`;
}

export interface CreateSandboxRequest {
  sessionId: string;
  sandboxId?: string; // Expected sandbox ID (generated by control plane)
  repoOwner: string | null;
  repoName: string | null;
  controlPlaneUrl: string;
  sandboxAuthToken: string;
  opencodeSessionId?: string;
  provider?: string;
  model?: string;
  userEnvVars?: Record<string, string>;
  prebuiltImageId?: string | null;
  prebuiltImageSha?: string | null;
  timeoutSeconds?: number;
  branch?: string | null;
  codeServerEnabled?: boolean;
  vncEnabled?: boolean;
  agentSlackNotifyEnabled?: boolean;
  mcpServers?: McpServerConfig[];
  sandboxSettings?: SandboxSettings;
  repositories?: SessionRepositoryInfo[];
  signal?: AbortSignal;
}

export interface CreateSandboxResponse {
  sandboxId: string;
  modalObjectId?: string; // Modal's internal object ID for snapshot API
  createdAt: number;
  codeServerUrl?: string;
  codeServerPassword?: string;
  vncUrl?: string;
  vncPassword?: string;
  ttydUrl?: string;
  tunnelUrls?: Record<string, string>;
}

export interface RestoreSandboxRequest {
  snapshotImageId: string;
  sessionId: string;
  sandboxId: string;
  sandboxAuthToken: string;
  controlPlaneUrl: string;
  repoOwner: string | null;
  repoName: string | null;
  provider: string;
  model: string;
  userEnvVars?: Record<string, string>;
  timeoutSeconds?: number;
  branch?: string | null;
  codeServerEnabled?: boolean;
  vncEnabled?: boolean;
  agentSlackNotifyEnabled?: boolean;
  mcpServers?: McpServerConfig[];
  sandboxSettings?: SandboxSettings;
  repositories?: SessionRepositoryInfo[];
  signal?: AbortSignal;
}

export interface RestoreSandboxResponse {
  success: boolean;
  sandboxId?: string;
  modalObjectId?: string;
  error?: string;
  codeServerUrl?: string;
  codeServerPassword?: string;
  vncUrl?: string;
  vncPassword?: string;
  ttydUrl?: string;
  tunnelUrls?: Record<string, string>;
}

export interface SnapshotSandboxRequest {
  providerObjectId: string;
  sessionId: string;
  signal?: AbortSignal;
}

export interface SnapshotSandboxResponse {
  success: boolean;
  imageId?: string;
  error?: string;
}

export interface SnapshotBuildSandboxRequest {
  buildId: string;
  providerSessionId: string;
  signal?: AbortSignal;
}

export interface CreateImageBuildSandboxRequest {
  /** Scope kind ("repo" | "environment") — accepted by Modal for logging only. */
  scopeKind: ImageBuildScopeKind;
  /** Scope id (lowercase owner/name or environment id) — logging only. */
  scopeId: string;
  buildId: string;
  /** Repositories in position order ([0] = primary), cloned at their base branches. */
  repositories: Array<{ repoOwner: string; repoName: string; baseBranch: string }>;
  cloneToken?: string;
  cloneHost?: string;
  cloneUsername?: string;
  callbackUrl: string;
  failureCallbackUrl: string;
  userEnvVars?: Record<string, string>;
  buildExecutionTimeoutSeconds: number;
  /** Provider-session lifetime, including deferred Queue finalization headroom. */
  providerSessionTimeoutSeconds: number;
  signal?: AbortSignal;
}

export interface CreateImageBuildSandboxResponse {
  providerSessionId: string;
}

export interface StartImageBuildSandboxRequest {
  buildId: string;
  providerSessionId: string;
  callbackToken: string;
  signal?: AbortSignal;
}

export interface TerminateImageBuildSandboxRequest {
  buildId: string;
  providerSessionId: string;
  reason: string;
  signal?: AbortSignal;
}

/**
 * Error thrown by ModalClient when the Modal API returns a non-OK HTTP status.
 * Carries the numeric status code so callers can classify without string parsing.
 */
export class ModalApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "ModalApiError";
  }
}

/**
 * Modal sandbox API client.
 *
 * Requires MODAL_API_SECRET for authentication and MODAL_WORKSPACE for URL construction.
 */
export class ModalClient {
  private createSandboxUrl: string;
  private snapshotSandboxUrl: string;
  private snapshotBuildSandboxUrl: string;
  private restoreSandboxUrl: string;
  private createImageBuildSandboxUrl: string;
  private startImageBuildSandboxUrl: string;
  private terminateImageBuildSandboxUrl: string;
  private secret: string;

  private async postJson<T>(
    url: string,
    endpoint: string,
    deadlineMs: number,
    body: unknown,
    schema: z.ZodType<T>,
    correlation: CorrelationContext | undefined,
    callerSignal: AbortSignal | undefined,
    onResponse: (status: number) => void
  ): Promise<T> {
    const headers = await this.getPostHeaders(correlation);
    return withRequestDeadline("Modal", endpoint, deadlineMs, callerSignal, async (signal) => {
      const response = await fetch(url, {
        method: "POST",
        headers,
        signal,
        body: JSON.stringify(body),
      });
      onResponse(response.status);
      if (!response.ok) {
        const text = await response.text();
        throw new ModalApiError(`Modal API error: ${response.status} ${text}`, response.status);
      }
      return parseModalApiResponse(schema, await response.json());
    });
  }

  constructor(secret: string, workspace: string, environmentWebSuffix?: string) {
    if (!secret) {
      throw new Error("ModalClient requires MODAL_API_SECRET for authentication");
    }
    if (!workspace) {
      throw new Error("ModalClient requires MODAL_WORKSPACE for URL construction");
    }
    this.secret = secret;
    const baseUrl = getModalBaseUrl(workspace, environmentWebSuffix);
    this.createSandboxUrl = `${baseUrl}-api-create-sandbox.modal.run`;
    this.snapshotSandboxUrl = `${baseUrl}-api-snapshot-sandbox.modal.run`;
    this.snapshotBuildSandboxUrl = `${baseUrl}-api-snapshot-build-sandbox.modal.run`;
    this.restoreSandboxUrl = `${baseUrl}-api-restore-sandbox.modal.run`;
    this.createImageBuildSandboxUrl = `${baseUrl}-api-create-build-sandbox.modal.run`;
    this.startImageBuildSandboxUrl = `${baseUrl}-api-start-build-sandbox.modal.run`;
    this.terminateImageBuildSandboxUrl = `${baseUrl}-api-terminate-build-sandbox.modal.run`;
  }

  /**
   * Generate authentication headers for POST/PUT requests (includes Content-Type).
   */
  private async getPostHeaders(correlation?: CorrelationContext): Promise<Record<string, string>> {
    const token = await generateInternalToken(this.secret);
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
      const result = await this.postJson(
        this.createSandboxUrl,
        endpoint,
        MODAL_SANDBOX_START_REQUEST_DEADLINE_MS,
        {
          session_id: request.sessionId,
          sandbox_id: request.sandboxId || null, // Use control-plane-generated ID
          repo_owner: request.repoOwner,
          repo_name: request.repoName,
          control_plane_url: request.controlPlaneUrl,
          sandbox_auth_token: request.sandboxAuthToken,
          opencode_session_id: request.opencodeSessionId || null,
          provider: request.provider || "anthropic",
          model: request.model || "claude-sonnet-4-6",
          user_env_vars: request.userEnvVars || null,
          repo_image_id: request.prebuiltImageId || null,
          repo_image_sha: request.prebuiltImageSha || null,
          timeout_seconds: request.timeoutSeconds || null,
          branch: request.branch || null,
          code_server_enabled: request.codeServerEnabled ?? false,
          vnc_enabled: request.vncEnabled ?? false,
          agent_slack_notify_enabled: request.agentSlackNotifyEnabled ?? false,
          mcp_servers: request.mcpServers || null,
          sandbox_settings: request.sandboxSettings ?? null,
          // Flat keys matching SessionConfig field names — Modal's create
          // handler builds its SessionConfig from the request by field name
          // (unlike restore, which carries a nested session_config).
          repositories: request.repositories?.length
            ? request.repositories.map(toRepositoryConfigPayload)
            : null,
        },
        createSandboxModalResponseSchema,
        correlation,
        request.signal,
        (status) => (httpStatus = status)
      );

      if (!result.success) {
        throw new Error(`Modal API error: ${result.error || "Unknown error"}`);
      }

      outcome = "success";
      return {
        sandboxId: result.data.sandbox_id,
        modalObjectId: result.data.modal_object_id ?? undefined,
        createdAt: result.data.created_at,
        codeServerUrl: result.data.code_server_url ?? undefined,
        codeServerPassword: result.data.code_server_password ?? undefined,
        vncUrl: result.data.vnc_url ?? undefined,
        vncPassword: result.data.vnc_password ?? undefined,
        ttydUrl: result.data.ttyd_url ?? undefined,
        tunnelUrls: result.data.tunnel_urls ?? undefined,
      };
    } finally {
      log.info("modal.request", {
        event: "modal.request",
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
      const result = await this.postJson(
        this.restoreSandboxUrl,
        endpoint,
        MODAL_SANDBOX_START_REQUEST_DEADLINE_MS,
        {
          snapshot_image_id: request.snapshotImageId,
          session_config: buildSessionConfig(request),
          sandbox_id: request.sandboxId,
          control_plane_url: request.controlPlaneUrl,
          sandbox_auth_token: request.sandboxAuthToken,
          user_env_vars: request.userEnvVars || null,
          timeout_seconds: request.timeoutSeconds || null,
          code_server_enabled: request.codeServerEnabled ?? false,
          vnc_enabled: request.vncEnabled ?? false,
          agent_slack_notify_enabled: request.agentSlackNotifyEnabled ?? false,
          sandbox_settings: request.sandboxSettings ?? null,
        },
        restoreSandboxModalResponseSchema,
        correlation,
        request.signal,
        (status) => (httpStatus = status)
      );

      if (!result.success) {
        return { success: false, error: result.error || "Unknown restore error" };
      }

      outcome = "success";
      return {
        success: true,
        sandboxId: result.data?.sandbox_id,
        modalObjectId: result.data?.modal_object_id ?? undefined,
        codeServerUrl: result.data?.code_server_url ?? undefined,
        codeServerPassword: result.data?.code_server_password ?? undefined,
        vncUrl: result.data?.vnc_url ?? undefined,
        vncPassword: result.data?.vnc_password ?? undefined,
        ttydUrl: result.data?.ttyd_url ?? undefined,
        tunnelUrls: result.data?.tunnel_urls ?? undefined,
      };
    } finally {
      log.info("modal.request", {
        event: "modal.request",
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
      const result = await this.postJson(
        this.snapshotSandboxUrl,
        endpoint,
        MODAL_SNAPSHOT_REQUEST_DEADLINE_MS,
        {
          sandbox_id: request.providerObjectId,
        },
        snapshotSandboxModalResponseSchema,
        correlation,
        request.signal,
        (status) => (httpStatus = status)
      );
      if (!result.success) {
        return { success: false, error: result.error || "Unknown snapshot error" };
      }

      if (!result.data?.image_id) {
        return { success: false, error: "Snapshot response missing image_id" };
      }

      outcome = "success";
      return { success: true, imageId: result.data.image_id };
    } finally {
      log.info("modal.request", {
        event: "modal.request",
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
   * Snapshot an image-build sandbox after Modal verifies its bound build tags.
   */
  async snapshotBuildSandbox(
    request: SnapshotBuildSandboxRequest,
    correlation?: CorrelationContext
  ): Promise<SnapshotSandboxResponse> {
    const startTime = Date.now();
    const endpoint = "snapshotBuildSandbox";
    let httpStatus: number | undefined;
    let outcome: "success" | "error" = "error";

    try {
      const result = await this.postJson(
        this.snapshotBuildSandboxUrl,
        endpoint,
        MODAL_SNAPSHOT_REQUEST_DEADLINE_MS,
        {
          build_id: request.buildId,
          provider_session_id: request.providerSessionId,
        },
        snapshotSandboxModalResponseSchema,
        correlation,
        request.signal,
        (status) => (httpStatus = status)
      );
      if (!result.success) {
        return { success: false, error: result.error || "Unknown snapshot error" };
      }
      if (!result.data?.image_id) {
        return { success: false, error: "Snapshot response missing image_id" };
      }

      outcome = "success";
      return { success: true, imageId: result.data.image_id };
    } finally {
      log.info("modal.request", {
        event: "modal.request",
        endpoint,
        build_id: request.buildId,
        sandbox_id: request.providerSessionId,
        trace_id: correlation?.trace_id,
        request_id: correlation?.request_id,
        http_status: httpStatus,
        duration_ms: Date.now() - startTime,
        outcome,
      });
    }
  }

  async createImageBuildSandbox(
    request: CreateImageBuildSandboxRequest,
    correlation?: CorrelationContext
  ): Promise<CreateImageBuildSandboxResponse> {
    const startTime = Date.now();
    const endpoint = "createImageBuildSandbox";
    let httpStatus: number | undefined;
    let outcome: "success" | "error" = "error";

    try {
      const result = await this.postJson(
        this.createImageBuildSandboxUrl,
        endpoint,
        MODAL_SANDBOX_START_REQUEST_DEADLINE_MS,
        {
          scope_kind: request.scopeKind,
          scope_id: request.scopeId,
          build_id: request.buildId,
          repositories: request.repositories.map(toRepositoryConfigPayload),
          clone_token: request.cloneToken,
          clone_host: request.cloneHost,
          clone_username: request.cloneUsername,
          callback_url: request.callbackUrl,
          failure_callback_url: request.failureCallbackUrl,
          user_env_vars: request.userEnvVars,
          build_execution_timeout_seconds: request.buildExecutionTimeoutSeconds,
          provider_session_timeout_seconds: request.providerSessionTimeoutSeconds,
        },
        createImageBuildSandboxModalResponseSchema,
        correlation,
        request.signal,
        (status) => (httpStatus = status)
      );

      if (result.success === false) {
        throw new Error(`Modal API error: ${result.error || "Unknown error"}`);
      }

      outcome = "success";
      return {
        providerSessionId: result.data.provider_session_id,
      };
    } finally {
      log.info("modal.request", {
        event: "modal.request",
        endpoint,
        build_id: request.buildId,
        scope_kind: request.scopeKind,
        scope_id: request.scopeId,
        trace_id: correlation?.trace_id,
        request_id: correlation?.request_id,
        http_status: httpStatus,
        duration_ms: Date.now() - startTime,
        outcome,
      });
    }
  }

  async startImageBuildSandbox(
    request: StartImageBuildSandboxRequest,
    correlation?: CorrelationContext
  ): Promise<void> {
    await this.postImageBuildOperation(
      this.startImageBuildSandboxUrl,
      "startImageBuildSandbox",
      MODAL_SANDBOX_START_REQUEST_DEADLINE_MS,
      request,
      {
        build_id: request.buildId,
        provider_session_id: request.providerSessionId,
        callback_token: request.callbackToken,
      },
      correlation
    );
  }

  async terminateImageBuildSandbox(
    request: TerminateImageBuildSandboxRequest,
    correlation?: CorrelationContext
  ): Promise<void> {
    await this.postImageBuildOperation(
      this.terminateImageBuildSandboxUrl,
      "terminateImageBuildSandbox",
      MODAL_CLEANUP_REQUEST_DEADLINE_MS,
      request,
      {
        build_id: request.buildId,
        provider_session_id: request.providerSessionId,
        reason: request.reason,
      },
      correlation
    );
  }

  private async postImageBuildOperation(
    url: string,
    endpoint: string,
    deadlineMs: number,
    request: { buildId: string; providerSessionId: string; signal?: AbortSignal },
    body: Record<string, unknown>,
    correlation?: CorrelationContext
  ): Promise<void> {
    const startTime = Date.now();
    let httpStatus: number | undefined;
    let outcome: "success" | "error" = "error";
    try {
      const result = await this.postJson(
        url,
        endpoint,
        deadlineMs,
        body,
        imageBuildOperationModalResponseSchema,
        correlation,
        request.signal,
        (status) => (httpStatus = status)
      );
      if (result.success === false) {
        throw new Error(`Modal API error: ${result.error || "Unknown error"}`);
      }
      outcome = "success";
    } finally {
      log.info("modal.request", {
        event: "modal.request",
        endpoint,
        build_id: request.buildId,
        sandbox_id: request.providerSessionId,
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
 * Create a new Modal client instance.
 *
 * This is a simple factory function that creates a new client each time.
 * The caller is responsible for managing the client lifecycle.
 *
 * @param secret - The MODAL_API_SECRET for authentication
 * @param workspace - The Modal workspace name
 * @param environmentWebSuffix - The Modal environment web suffix used in endpoint URLs
 * @returns A new ModalClient instance
 * @throws Error if secret or workspace is not provided
 */
export function createModalClient(
  secret: string,
  workspace: string,
  environmentWebSuffix?: string
): ModalClient {
  if (!secret) {
    throw new Error("MODAL_API_SECRET is required to create ModalClient");
  }
  if (!workspace) {
    throw new Error("MODAL_WORKSPACE is required to create ModalClient");
  }
  return new ModalClient(secret, workspace, environmentWebSuffix);
}
