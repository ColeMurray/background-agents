import type { SandboxEvent as SharedSandboxEvent } from "@open-inspect/shared";

// Session-related type definitions

export interface Artifact {
  id: string;
  type: "pr" | "screenshot" | "preview" | "branch";
  url: string | null;
  metadata?: {
    number?: number;
    state?: "open" | "merged" | "closed" | "draft";
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
