/**
 * Modal sandbox manager.
 *
 * Implements the SandboxManager interface using Modal's container platform.
 * Supports snapshots and restore functionality.
 */

import { generateInternalToken } from "@open-inspect/shared";
import type { Env } from "../types";
import type {
  SandboxManager,
  StartSandboxConfig,
  StartSandboxResult,
  CreateSnapshotConfig,
  CreateSnapshotResult,
  RestoreSnapshotConfig,
} from "./types";

// Modal app name
const MODAL_APP_NAME = "open-inspect";

/**
 * Construct the Modal base URL from workspace name.
 * Modal endpoint URLs follow the pattern: https://{workspace}--{app-name}
 */
function getModalBaseUrl(workspace: string): string {
  return `https://${workspace}--${MODAL_APP_NAME}`;
}

interface ModalApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Modal sandbox manager.
 *
 * Manages sandbox lifecycle using Modal's container platform.
 * Requires MODAL_API_SECRET and MODAL_WORKSPACE environment variables.
 */
export class ModalSandboxManager implements SandboxManager {
  private readonly secret: string;
  private readonly workspace: string;
  private readonly createSandboxUrl: string;
  private readonly warmSandboxUrl: string;
  private readonly healthUrl: string;
  private readonly snapshotUrl: string;
  private readonly snapshotSandboxUrl: string;
  private readonly restoreSandboxUrl: string;

  constructor(env: Env) {
    const secret = env.MODAL_API_SECRET;
    const workspace = env.MODAL_WORKSPACE;

    if (!secret) {
      throw new Error("MODAL_API_SECRET is required for Modal sandbox backend");
    }
    if (!workspace) {
      throw new Error("MODAL_WORKSPACE is required for Modal sandbox backend");
    }

    this.secret = secret;
    this.workspace = workspace;

    const baseUrl = getModalBaseUrl(workspace);
    this.createSandboxUrl = `${baseUrl}-api-create-sandbox.modal.run`;
    this.warmSandboxUrl = `${baseUrl}-api-warm-sandbox.modal.run`;
    this.healthUrl = `${baseUrl}-api-health.modal.run`;
    this.snapshotUrl = `${baseUrl}-api-snapshot.modal.run`;
    this.snapshotSandboxUrl = `${baseUrl}-api-snapshot-sandbox.modal.run`;
    this.restoreSandboxUrl = `${baseUrl}-api-restore-sandbox.modal.run`;
  }

  /**
   * Generate authentication headers for POST/PUT requests.
   */
  private async getPostHeaders(): Promise<Record<string, string>> {
    const token = await generateInternalToken(this.secret);
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };
  }

  /**
   * Modal supports snapshots.
   */
  supportsSnapshots(): boolean {
    return true;
  }

  /**
   * Start a new sandbox via Modal API.
   */
  async startSandbox(config: StartSandboxConfig): Promise<StartSandboxResult> {
    console.log(`[modal] Creating sandbox via Modal API: ${config.sessionId}`);

    const headers = await this.getPostHeaders();
    const response = await fetch(this.createSandboxUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        session_id: config.sessionId,
        sandbox_id: config.sandboxId,
        repo_owner: config.repoOwner,
        repo_name: config.repoName,
        control_plane_url: config.controlPlaneUrl,
        sandbox_auth_token: config.sandboxAuthToken,
        snapshot_id: config.snapshotId || null,
        opencode_session_id: config.opencodeSessionId || null,
        git_user_name: config.gitUserName || null,
        git_user_email: config.gitUserEmail || null,
        provider: config.provider || "anthropic",
        model: config.model || "claude-sonnet-4-5",
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Modal API error: ${response.status} ${text}`);
    }

    const result = (await response.json()) as ModalApiResponse<{
      sandbox_id: string;
      modal_object_id?: string;
      status: string;
      created_at: number;
    }>;

    if (!result.success || !result.data) {
      throw new Error(`Modal API error: ${result.error || "Unknown error"}`);
    }

    return {
      sandboxId: result.data.sandbox_id,
      modalObjectId: result.data.modal_object_id,
      status: result.data.status,
      createdAt: result.data.created_at,
    };
  }

  /**
   * Destroy a sandbox.
   *
   * Note: Modal sandboxes are automatically cleaned up, but this method
   * can be used to explicitly terminate a running sandbox.
   */
  async destroySandbox(sandboxId: string): Promise<void> {
    console.log(`[modal] Destroying sandbox ${sandboxId} (Modal handles cleanup automatically)`);
    // Modal sandboxes are managed by Modal's lifecycle
    // No explicit destroy call needed - they timeout automatically
  }

  /**
   * Create a snapshot of a sandbox.
   */
  async createSnapshot(config: CreateSnapshotConfig): Promise<CreateSnapshotResult | null> {
    console.log(
      `[modal] Creating snapshot for sandbox ${config.modalObjectId}, reason: ${config.reason}`
    );

    const headers = await this.getPostHeaders();
    const response = await fetch(this.snapshotSandboxUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sandbox_id: config.modalObjectId,
        session_id: config.sessionId,
        reason: config.reason,
      }),
    });

    if (!response.ok) {
      console.error(`[modal] Snapshot request failed: ${response.status}`);
      return null;
    }

    const result = (await response.json()) as ModalApiResponse<{ image_id: string }>;

    if (!result.success || !result.data?.image_id) {
      console.error(`[modal] Snapshot failed: ${result.error || "Unknown error"}`);
      return null;
    }

    console.log(`[modal] Snapshot created: ${result.data.image_id}`);
    return { imageId: result.data.image_id };
  }

  /**
   * Restore a sandbox from a snapshot.
   */
  async restoreSnapshot(config: RestoreSnapshotConfig): Promise<StartSandboxResult | null> {
    console.log(`[modal] Restoring sandbox from snapshot ${config.snapshotImageId}`);

    const headers = await this.getPostHeaders();
    const response = await fetch(this.restoreSandboxUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        snapshot_image_id: config.snapshotImageId,
        session_id: config.sessionId,
        sandbox_id: config.sandboxId,
        repo_owner: config.repoOwner,
        repo_name: config.repoName,
        control_plane_url: config.controlPlaneUrl,
        sandbox_auth_token: config.sandboxAuthToken,
        provider: config.provider || "anthropic",
        model: config.model || "claude-sonnet-4-5",
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[modal] Restore failed: ${response.status} ${text}`);
      return null;
    }

    const result = (await response.json()) as ModalApiResponse<{
      sandbox_id: string;
      modal_object_id?: string;
      status: string;
      created_at: number;
    }>;

    if (!result.success || !result.data) {
      console.error(`[modal] Restore failed: ${result.error || "Unknown error"}`);
      return null;
    }

    console.log(`[modal] Sandbox restored: ${result.data.sandbox_id}`);
    return {
      sandboxId: result.data.sandbox_id,
      modalObjectId: result.data.modal_object_id,
      status: result.data.status,
      createdAt: result.data.created_at,
    };
  }

  /**
   * Pre-warm a sandbox for faster startup.
   */
  async warmSandbox(
    repoOwner: string,
    repoName: string,
    controlPlaneUrl?: string
  ): Promise<{ sandboxId: string; status: string }> {
    console.log(`[modal] Warming sandbox for ${repoOwner}/${repoName}`);

    const headers = await this.getPostHeaders();
    const response = await fetch(this.warmSandboxUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        repo_owner: repoOwner,
        repo_name: repoName,
        control_plane_url: controlPlaneUrl || "",
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Modal API error: ${response.status} ${text}`);
    }

    const result = (await response.json()) as ModalApiResponse<{
      sandbox_id: string;
      status: string;
    }>;

    if (!result.success || !result.data) {
      throw new Error(`Modal API error: ${result.error || "Unknown error"}`);
    }

    return {
      sandboxId: result.data.sandbox_id,
      status: result.data.status,
    };
  }

  /**
   * Check Modal API health.
   */
  async health(): Promise<{ status: string; service: string }> {
    const response = await fetch(this.healthUrl);

    if (!response.ok) {
      throw new Error(`Modal API error: ${response.status}`);
    }

    const result = (await response.json()) as ModalApiResponse<{
      status: string;
      service: string;
    }>;

    if (!result.success || !result.data) {
      throw new Error(`Modal API error: ${result.error || "Unknown error"}`);
    }

    return result.data;
  }

  /**
   * Get the latest snapshot for a repository.
   */
  async getLatestSnapshot(
    repoOwner: string,
    repoName: string
  ): Promise<{
    id: string;
    repoOwner: string;
    repoName: string;
    baseSha: string;
    status: string;
    createdAt: string;
    expiresAt?: string;
  } | null> {
    const token = await generateInternalToken(this.secret);
    const url = `${this.snapshotUrl}?repo_owner=${encodeURIComponent(repoOwner)}&repo_name=${encodeURIComponent(repoName)}`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      return null;
    }

    const result = (await response.json()) as ModalApiResponse<{
      id: string;
      repo_owner: string;
      repo_name: string;
      base_sha: string;
      status: string;
      created_at: string;
      expires_at?: string;
    }>;

    if (!result.success || !result.data) {
      return null;
    }

    return {
      id: result.data.id,
      repoOwner: result.data.repo_owner,
      repoName: result.data.repo_name,
      baseSha: result.data.base_sha,
      status: result.data.status,
      createdAt: result.data.created_at,
      expiresAt: result.data.expires_at,
    };
  }
}

/**
 * Create a Modal sandbox manager.
 */
export function createModalSandboxManager(env: Env): ModalSandboxManager {
  return new ModalSandboxManager(env);
}
