/**
 * Modal sandbox API adapter.
 *
 * Provides methods to interact with Modal sandboxes from the control plane.
 * All requests are authenticated using HMAC-signed tokens.
 */

import { generateInternalToken } from "@open-inspect/shared";
import type { ModalPort } from "../ports/modal-port";
import type { CreateSandboxRequest, SandboxResponse, SnapshotResponse } from "../ports/types";

const MODAL_APP_NAME = "open-inspect";

function getModalBaseUrl(workspace: string): string {
  return `https://${workspace}--${MODAL_APP_NAME}`;
}

export interface WarmSandboxRequest {
  repoOwner: string;
  repoName: string;
  controlPlaneUrl?: string;
}

export interface WarmSandboxResponse {
  sandboxId: string;
  status: string;
}

export interface SnapshotInfo {
  id: string;
  repoOwner: string;
  repoName: string;
  baseSha: string;
  status: string;
  createdAt: string;
  expiresAt?: string;
}

interface ModalApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export class ModalAdapter implements ModalPort {
  private createSandboxUrl: string;
  private warmSandboxUrl: string;
  private healthUrl: string;
  private snapshotUrl: string;
  private snapshotSandboxUrl: string;
  private restoreSandboxUrl: string;
  private secret: string;

  constructor(secret: string, workspace: string) {
    if (!secret) {
      throw new Error("ModalAdapter requires MODAL_API_SECRET for authentication");
    }
    if (!workspace) {
      throw new Error("ModalAdapter requires MODAL_WORKSPACE for URL construction");
    }
    this.secret = secret;
    const baseUrl = getModalBaseUrl(workspace);
    this.createSandboxUrl = `${baseUrl}-api-create-sandbox.modal.run`;
    this.warmSandboxUrl = `${baseUrl}-api-warm-sandbox.modal.run`;
    this.healthUrl = `${baseUrl}-api-health.modal.run`;
    this.snapshotUrl = `${baseUrl}-api-snapshot.modal.run`;
    this.snapshotSandboxUrl = `${baseUrl}-api-snapshot-sandbox.modal.run`;
    this.restoreSandboxUrl = `${baseUrl}-api-restore-sandbox.modal.run`;
  }

  private async getPostHeaders(): Promise<Record<string, string>> {
    const token = await generateInternalToken(this.secret);
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };
  }

  private async getGetHeaders(): Promise<Record<string, string>> {
    const token = await generateInternalToken(this.secret);
    return {
      Authorization: `Bearer ${token}`,
    };
  }

  async createSandbox(request: CreateSandboxRequest): Promise<SandboxResponse> {
    console.log("Creating sandbox via Modal API:", request.sessionId);

    const headers = await this.getPostHeaders();
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
        git_user_name: request.gitUserName || null,
        git_user_email: request.gitUserEmail || null,
        provider: request.provider || "anthropic",
        model: request.model || "claude-sonnet-4-5",
        linear: request.linear
          ? {
              issue_id: request.linear.issueId,
              title: request.linear.title,
              url: request.linear.url,
              description: request.linear.description ?? null,
            }
          : null,
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
      preview_tunnel_url?: string;
      tunnel_urls?: Record<number, string>;
    }>;

    if (!result.success || !result.data) {
      throw new Error(`Modal API error: ${result.error || "Unknown error"}`);
    }

    return {
      sandboxId: result.data.sandbox_id,
      modalObjectId: result.data.modal_object_id,
      status: result.data.status,
      createdAt: result.data.created_at,
      previewTunnelUrl: result.data.preview_tunnel_url,
      tunnelUrls: result.data.tunnel_urls,
    };
  }

  async snapshotSandbox(
    sandboxId: string,
    sessionId: string,
    reason: string
  ): Promise<SnapshotResponse> {
    const headers = await this.getPostHeaders();
    const response = await fetch(this.snapshotSandboxUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sandbox_id: sandboxId,
        session_id: sessionId,
        reason: reason,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Modal API error: ${response.status} ${text}`);
    }

    const result = (await response.json()) as ModalApiResponse<{
      image_id: string;
    }>;

    if (!result.success || !result.data?.image_id) {
      throw new Error(result.error || "Snapshot failed");
    }

    return {
      snapshotId: result.data.image_id,
    };
  }

  async warmSandbox(request: WarmSandboxRequest): Promise<WarmSandboxResponse> {
    console.log("Warming sandbox via Modal API:", request.repoOwner, request.repoName);

    const headers = await this.getPostHeaders();
    const response = await fetch(this.warmSandboxUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        repo_owner: request.repoOwner,
        repo_name: request.repoName,
        control_plane_url: request.controlPlaneUrl || "",
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

  async getLatestSnapshot(repoOwner: string, repoName: string): Promise<SnapshotInfo | null> {
    const url = `${this.snapshotUrl}?repo_owner=${encodeURIComponent(repoOwner)}&repo_name=${encodeURIComponent(repoName)}`;

    const headers = await this.getGetHeaders();
    const response = await fetch(url, { headers });

    if (!response.ok) {
      return null;
    }

    const result = (await response.json()) as ModalApiResponse<SnapshotInfo>;

    if (!result.success) {
      return null;
    }

    return result.data || null;
  }
}
