import type {
  PullRequestDisplayStatus,
  SandboxEvent as SharedSandboxEvent,
  ScreenshotArtifactMetadata,
  VideoArtifactMetadata,
} from "@open-inspect/shared";

// Session-related type definitions

export interface Artifact {
  id: string;
  type: "pr" | "screenshot" | "video" | "preview" | "branch";
  url: string | null;
  metadata?: (Partial<ScreenshotArtifactMetadata> | Partial<VideoArtifactMetadata>) & {
    prNumber?: number;
    prState?: PullRequestDisplayStatus;
    mode?: "manual_pr";
    createPrUrl?: string;
    head?: string;
    base?: string;
    provider?: string;
    filename?: string;
    previewStatus?: "active" | "outdated" | "stopped";
    // Repo a PR/branch artifact belongs to in a multi-repo session. Absent on
    // artifacts written before multi-repo support → they belong to the primary.
    repoOwner?: string;
    repoName?: string;
  };
  createdAt: number;
  /** Last content change (PR lifecycle updates); falls back to createdAt. */
  updatedAt?: number;
}

export type SandboxEvent = SharedSandboxEvent;

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
