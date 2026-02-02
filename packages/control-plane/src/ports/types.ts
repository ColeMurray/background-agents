export interface CreatePRRequest {
  accessTokenEncrypted: string;
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
}

export interface CreatePRResponse {
  number: number;
  url: string;
  state: string;
  htmlUrl: string;
}

export interface RepositoryInfo {
  defaultBranch: string;
  private: boolean;
  fullName: string;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url?: string | null;
  state?: { id: string; name: string } | null;
  team?: { id: string; key: string; name: string } | null;
}

export interface ListIssuesOptions {
  teamId?: string;
  teamKey?: string;
  query?: string;
  cursor?: string | null;
  limit?: number;
}

export interface CreateIssueInput {
  teamId: string;
  title: string;
  description?: string | null;
}

export interface UpdateIssueInput {
  stateId?: string | null;
  assigneeId?: string | null;
  title?: string | null;
  description?: string | null;
}

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
