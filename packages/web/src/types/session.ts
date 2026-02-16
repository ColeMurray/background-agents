// Session-related type definitions

export interface Artifact {
  id: string;
  type: "pr" | "screenshot" | "preview" | "branch";
  url: string | null;
  metadata?: {
    // pr metadata
    prNumber?: number;
    prState?: "open" | "merged" | "closed" | "draft";
    // screenshot metadata
    filename?: string;
    description?: string;
    viewport?: { width: number; height: number };
    selector?: string;
    capturedAt?: number;
    // preview metadata
    port?: number;
    previewStatus?: "active" | "outdated" | "stopped";
  };
  createdAt: number;
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
