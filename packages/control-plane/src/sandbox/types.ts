/**
 * Shared types and interfaces for sandbox backends.
 *
 * This module defines the common interface that all sandbox backends
 * (Modal, Cloudflare, etc.) must implement.
 */

/**
 * Configuration for starting a sandbox.
 */
export interface StartSandboxConfig {
  sessionId: string;
  sandboxId: string;
  repoOwner: string;
  repoName: string;
  controlPlaneUrl: string;
  sandboxAuthToken: string;
  provider?: string;
  model?: string;
  // Modal-specific (optional)
  snapshotId?: string;
  opencodeSessionId?: string;
  // Git user info (optional)
  gitUserName?: string;
  gitUserEmail?: string;
  // Cloudflare-specific (optional)
  githubAppToken?: string;
}

/**
 * Result from starting a sandbox.
 */
export interface StartSandboxResult {
  sandboxId: string;
  status: string;
  // Modal-specific (optional)
  modalObjectId?: string;
  createdAt?: number;
}

/**
 * Configuration for creating a snapshot.
 */
export interface CreateSnapshotConfig {
  sandboxId: string;
  modalObjectId: string;
  sessionId: string;
  reason: string;
}

/**
 * Result from creating a snapshot.
 */
export interface CreateSnapshotResult {
  imageId: string;
}

/**
 * Configuration for restoring from a snapshot.
 */
export interface RestoreSnapshotConfig {
  snapshotImageId: string;
  sessionId: string;
  sandboxId: string;
  repoOwner: string;
  repoName: string;
  controlPlaneUrl: string;
  sandboxAuthToken: string;
  provider?: string;
  model?: string;
}

/**
 * Sandbox manager interface.
 *
 * All sandbox backends must implement this interface to be used
 * by the control plane's SessionDO.
 */
export interface SandboxManager {
  /**
   * Start a new sandbox.
   */
  startSandbox(config: StartSandboxConfig): Promise<StartSandboxResult>;

  /**
   * Destroy a sandbox.
   */
  destroySandbox(sandboxId: string): Promise<void>;

  /**
   * Check if this backend supports snapshots.
   */
  supportsSnapshots(): boolean;

  /**
   * Create a snapshot of a sandbox (optional - only some backends support this).
   * Returns null if snapshots are not supported.
   */
  createSnapshot?(config: CreateSnapshotConfig): Promise<CreateSnapshotResult | null>;

  /**
   * Restore a sandbox from a snapshot (optional - only some backends support this).
   * Returns null if snapshots are not supported.
   */
  restoreSnapshot?(config: RestoreSnapshotConfig): Promise<StartSandboxResult | null>;
}

/**
 * Supported sandbox backend types.
 */
export type SandboxBackend = "modal" | "cloudflare";
