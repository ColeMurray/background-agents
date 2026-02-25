// Session-related type definitions

export interface Artifact {
  id: string;
  type: "pr" | "screenshot" | "preview" | "branch";
  url: string | null;
  metadata?: {
    prNumber?: number;
    prState?: "open" | "merged" | "closed" | "draft";
    mode?: "manual_pr";
    createPrUrl?: string;
    head?: string;
    base?: string;
    provider?: string;
    filename?: string;
    previewStatus?: "active" | "outdated" | "stopped";
  };
  createdAt: number;
}

export interface SandboxEvent {
  type: string;
  content?: string;
  messageId?: string;
  tool?: string;
  args?: Record<string, unknown>;
  callId?: string;
  result?: string;
  error?: string;
  success?: boolean;
  status?: string;
  output?: string;
  sha?: string;
  timestamp: number;
  author?: {
    participantId: string;
    name: string;
    avatar?: string;
  };
}

export interface Task {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export interface FileChange {
  filename: string;
  additions: number;
  deletions: number;
}

export interface ChildSession {
  id: string;
  description: string;
  prNumber?: number;
  prState?: "open" | "merged" | "closed" | "draft";
  platform?: string;
}

export interface SessionMetadata {
  title: string;
  model?: string;
  branchName?: string;
  projectTag?: string;
  createdAt: number;
  updatedAt?: number;
}
