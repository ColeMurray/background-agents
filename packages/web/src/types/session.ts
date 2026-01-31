// Session-related type definitions

export interface Artifact {
  id: string;
  type: "pr" | "screenshot" | "preview" | "branch";
  url: string | null;
  metadata?: {
    prNumber?: number;
    prState?: "open" | "merged" | "closed" | "draft";
    filename?: string;
    previewStatus?: "active" | "outdated" | "stopped";
    tunnelUrls?: Record<string, string>;
  };
  createdAt: number;
}

export interface Task {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
  /** Stable key for Linear linking (from latest TodoWrite event) */
  messageId?: string;
  eventId?: string;
  taskIndex?: number;
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

export interface TaskLinearLink {
  messageId: string;
  eventId: string;
  taskIndex: number;
  linearIssueId: string;
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
