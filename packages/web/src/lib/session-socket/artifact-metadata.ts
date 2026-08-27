import type { Artifact } from "@/types/session";
import {
  toDisplayStatus,
  type PullRequestDisplayStatus,
  type ScreenshotArtifactMetadata,
  type SessionArtifact,
  type VideoArtifactMetadata,
} from "@open-inspect/shared/types/artifacts";

/**
 * Maps the wire artifact shape (`SessionArtifact`, with loosely-typed
 * metadata) to the UI `Artifact`, narrowing each metadata field to its
 * expected type and deriving the PR display status.
 */

const PR_DISPLAY_STATUSES = new Set<PullRequestDisplayStatus>([
  "open",
  "merged",
  "closed",
  "draft",
]);

/**
 * The PR display status for an artifact's metadata. Prefers the tracked
 * lifecycleState/isDraft pair (derived via shared toDisplayStatus); falls
 * back to the legacy `state` display key on artifacts that predate PR
 * lifecycle tracking.
 */
function derivePrState(meta: Record<string, unknown>): PullRequestDisplayStatus | undefined {
  if (meta.lifecycleState === "open" || meta.lifecycleState === "closed") {
    return toDisplayStatus({ lifecycleState: meta.lifecycleState, isDraft: meta.isDraft === true });
  }
  if (meta.lifecycleState === "merged") {
    return "merged";
  }
  return typeof meta.state === "string" &&
    PR_DISPLAY_STATUSES.has(meta.state as PullRequestDisplayStatus)
    ? (meta.state as PullRequestDisplayStatus)
    : undefined;
}

type MediaMimeType = ScreenshotArtifactMetadata["mimeType"] | VideoArtifactMetadata["mimeType"];
const MEDIA_MIME_TYPES = new Set<MediaMimeType>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "video/mp4",
]);

function isMediaMimeType(value: string): value is MediaMimeType {
  return MEDIA_MIME_TYPES.has(value as MediaMimeType);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function narrowDimensions(value: unknown): { width: number; height: number } | undefined {
  if (!isRecord(value)) return undefined;
  const { width, height } = value;
  return typeof width === "number" && typeof height === "number" ? { width, height } : undefined;
}

export function toUiArtifact(artifact: SessionArtifact): Artifact {
  const meta = artifact.metadata;
  return {
    id: artifact.id,
    type: artifact.type as Artifact["type"],
    url: artifact.url,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    metadata: meta
      ? {
          prNumber: typeof meta.number === "number" ? meta.number : undefined,
          prState: derivePrState(meta),
          mode: meta.mode === "manual_pr" ? "manual_pr" : undefined,
          createPrUrl: typeof meta.createPrUrl === "string" ? meta.createPrUrl : undefined,
          head: typeof meta.head === "string" ? meta.head : undefined,
          base: typeof meta.base === "string" ? meta.base : undefined,
          provider: typeof meta.provider === "string" ? meta.provider : undefined,
          filename: typeof meta.filename === "string" ? meta.filename : undefined,
          objectKey: typeof meta.objectKey === "string" ? meta.objectKey : undefined,
          mimeType:
            typeof meta.mimeType === "string" && isMediaMimeType(meta.mimeType)
              ? meta.mimeType
              : undefined,
          sizeBytes: typeof meta.sizeBytes === "number" ? meta.sizeBytes : undefined,
          viewport: narrowDimensions(meta.viewport),
          sourceUrl: typeof meta.sourceUrl === "string" ? meta.sourceUrl : undefined,
          endUrl: typeof meta.endUrl === "string" ? meta.endUrl : undefined,
          fullPage: typeof meta.fullPage === "boolean" ? meta.fullPage : undefined,
          annotated: typeof meta.annotated === "boolean" ? meta.annotated : undefined,
          caption: typeof meta.caption === "string" ? meta.caption : undefined,
          durationMs: typeof meta.durationMs === "number" ? meta.durationMs : undefined,
          recordingStartedAt:
            typeof meta.recordingStartedAt === "number" ? meta.recordingStartedAt : undefined,
          recordingEndedAt:
            typeof meta.recordingEndedAt === "number" ? meta.recordingEndedAt : undefined,
          dimensions: narrowDimensions(meta.dimensions),
          truncated: typeof meta.truncated === "boolean" ? meta.truncated : undefined,
          hasAudio: meta.hasAudio === false ? false : undefined,
          previewStatus:
            meta.previewStatus === "active" ||
            meta.previewStatus === "outdated" ||
            meta.previewStatus === "stopped"
              ? meta.previewStatus
              : undefined,
          repoOwner: typeof meta.repoOwner === "string" ? meta.repoOwner : undefined,
          repoName: typeof meta.repoName === "string" ? meta.repoName : undefined,
        }
      : undefined,
  };
}
