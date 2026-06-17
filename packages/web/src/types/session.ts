import type { SandboxEvent as SharedSandboxEvent } from "@open-inspect/shared";

// Session-related type definitions

export interface Artifact {
  id: string;
  type: "pr" | "screenshot" | "video" | "preview" | "branch" | "file";
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
    objectKey?: string;
    mimeType?: string;
    sizeBytes?: number;
    viewport?: { width: number; height: number };
    sourceUrl?: string;
    endUrl?: string;
    fullPage?: boolean;
    annotated?: boolean;
    caption?: string;
    durationMs?: number;
    recordingStartedAt?: number;
    recordingEndedAt?: number;
    dimensions?: { width: number; height: number };
    truncated?: boolean;
    hasAudio?: false;
    previewStatus?: "active" | "outdated" | "stopped";
  };
  createdAt: number;
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
