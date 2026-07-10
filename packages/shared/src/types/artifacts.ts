import { z } from "zod";
import { artifactTypeSchema } from "./statuses";
import type { ArtifactType } from "./statuses";

export const recordSchema = z.record(z.string(), z.unknown());

// Artifact created by session
export interface SessionArtifact {
  id: string;
  type: ArtifactType;
  url: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

export const sessionArtifactSchema = z.object({
  id: z.string(),
  type: artifactTypeSchema,
  url: z.string().nullable(),
  metadata: recordSchema.nullable(),
  createdAt: z.number(),
});

/**
 * Metadata stored on branch artifacts when PR creation falls back to manual flow.
 */
export interface ManualPullRequestArtifactMetadata {
  mode: "manual_pr";
  head: string;
  base: string;
  createPrUrl: string;
  provider?: string;
}

/** Metadata stored on screenshot artifacts. */
export interface ScreenshotArtifactMetadata {
  /** R2 object key */
  objectKey: string;
  /** MIME type: image/png, image/jpeg, image/webp */
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  /** File size in bytes */
  sizeBytes: number;
  /** Viewport dimensions at capture time */
  viewport?: { width: number; height: number };
  /** URL that was screenshotted */
  sourceUrl?: string;
  /** Whether this is a full-page screenshot */
  fullPage?: boolean;
  /** Whether element annotations are overlaid */
  annotated?: boolean;
  /** Caption or description provided by the agent */
  caption?: string;
}

/** Metadata stored on video recording artifacts. */
export interface VideoArtifactMetadata {
  /** R2 object key */
  objectKey: string;
  /** MIME type for saved recordings. */
  mimeType: "video/mp4";
  /** File size in bytes */
  sizeBytes: number;
  /** Agent-provided title or description of the validation recording */
  caption: string;
  /** Recording duration in milliseconds */
  durationMs: number;
  /** Artifact creation time as epoch milliseconds */
  createdAt: number;
  /** Recording start time as epoch milliseconds */
  recordingStartedAt: number;
  /** Recording end time as epoch milliseconds */
  recordingEndedAt: number;
  /** Captured viewport dimensions */
  dimensions: { width: number; height: number };
  /** Whether recording stopped at the maximum duration */
  truncated: boolean;
  /** Recordings must not include audio */
  hasAudio?: false;
  /** Captured surface for v1 */
  captureSurface?: "browser";
  /** Artifact source */
  source?: "agent";
  /** URL at recording start */
  sourceUrl?: string;
  /** URL when recording stopped */
  endUrl?: string;
}

// Pull request info
export interface PullRequest {
  number: number;
  title: string;
  body: string;
  url: string;
  state: "open" | "closed" | "merged" | "draft";
  headRef: string;
  baseRef: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactResponse {
  id: string;
  type: ArtifactType;
  url: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

export interface ListArtifactsResponse {
  artifacts: ArtifactResponse[];
}

export interface ToolCallSummary {
  tool: string;
  summary: string;
}

export interface ArtifactInfo {
  type: ArtifactType;
  url: string;
  label: string;
  metadata?: Record<string, unknown> | null;
}

export interface AgentResponse {
  textContent: string;
  toolCalls: ToolCallSummary[];
  artifacts: ArtifactInfo[];
  success: boolean;
  error?: string;
}
