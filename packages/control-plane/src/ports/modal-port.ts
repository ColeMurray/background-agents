export interface LinearContext {
  issueId: string;
  title: string;
  url: string;
  description?: string | null;
}

export interface CreateSandboxRequest {
  sessionId: string;
  sandboxId?: string;
  repoOwner: string;
  repoName: string;
  controlPlaneUrl: string;
  sandboxAuthToken: string;
  snapshotId?: string;
  opencodeSessionId?: string;
  gitUserName?: string;
  gitUserEmail?: string;
  provider?: string;
  model?: string;
  linear?: LinearContext;
}

export interface SandboxResponse {
  sandboxId: string;
  modalObjectId?: string;
  status: string;
  createdAt: number;
  previewTunnelUrl?: string;
  tunnelUrls?: Record<number, string>;
}

export interface SnapshotResponse {
  snapshotId: string;
}

export interface SandboxStatusResponse {
  status: string;
}

export interface ModalPort {
  createSandbox(request: CreateSandboxRequest): Promise<SandboxResponse>;
  snapshotSandbox(sandboxId: string, sessionId: string, reason: string): Promise<SnapshotResponse>;
  // restoreSandbox(snapshotId: string): Promise<SandboxResponse>; // Not present in current usage, skipping for now or making optional?
}
