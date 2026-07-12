import type { Artifact, SandboxEvent } from "@/types/session";
import { serverMessageSchema, toDisplayStatus } from "@open-inspect/shared";
import type {
  PullRequestDisplayStatus,
  ScreenshotArtifactMetadata,
  ServerMessage,
  SessionArtifact,
  VideoArtifactMetadata,
} from "@open-inspect/shared";

export type AssistantTokenEvent = Extract<SandboxEvent, { type: "token" }>;

/**
 * The latest streamed assistant text for an in-flight message. Token events
 * contain the full accumulated text (not incremental), so only the most
 * recent one needs to be retained.
 */
export type PendingAssistantText = Pick<
  AssistantTokenEvent,
  "content" | "messageId" | "sandboxId" | "timestamp"
>;

export function parseWsMessage(raw: unknown): ServerMessage | null {
  const result = serverMessageSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export function toUiSandboxEvent(event: SandboxEvent): SandboxEvent {
  return {
    ...event,
    timestamp: typeof event.timestamp === "number" ? event.timestamp : Date.now() / 1000,
  };
}

function isRenderableTokenEvent(event: SandboxEvent): event is AssistantTokenEvent {
  return event.type === "token" && Boolean(event.content) && Boolean(event.messageId);
}

/**
 * Token events contain cumulative text. Replay should show one final token per
 * message, independent of tied storage ordering between token and completion.
 */
export function collapseReplayTokenEvents(events: SandboxEvent[]): SandboxEvent[] {
  const tokenByMessageId = new Map<string, AssistantTokenEvent>();

  for (const event of events) {
    if (isRenderableTokenEvent(event)) {
      tokenByMessageId.set(event.messageId, event);
    }
  }

  if (tokenByMessageId.size === 0) {
    return events;
  }

  const result: SandboxEvent[] = [];
  const emittedTokenMessageIds = new Set<string>();

  for (const evt of events) {
    if (isRenderableTokenEvent(evt)) {
      continue;
    }

    if (evt.type === "execution_complete") {
      const token = tokenByMessageId.get(evt.messageId);
      if (token && !emittedTokenMessageIds.has(evt.messageId)) {
        result.push(token);
        emittedTokenMessageIds.add(evt.messageId);
      }
    }

    result.push(evt);
  }

  for (const [messageId, token] of tokenByMessageId) {
    if (!emittedTokenMessageIds.has(messageId)) {
      result.push(token);
    }
  }

  return result;
}

export interface LiveEventIngestion {
  /** The pending assistant text after processing this event. */
  pending: PendingAssistantText | null;
  /** Events ready to append to the visible event log. */
  append: SandboxEvent[];
}

/**
 * Step function for live sandbox events. Streamed token text is buffered
 * (not displayed) until its execution completes, at which point the final
 * text is emitted once with the token's original timestamp. All other
 * events pass through unchanged.
 */
export function ingestLiveSandboxEvent(
  pending: PendingAssistantText | null,
  event: SandboxEvent
): LiveEventIngestion {
  if (event.type === "token" && event.content && event.messageId) {
    return {
      pending: {
        content: event.content,
        messageId: event.messageId,
        sandboxId: event.sandboxId,
        timestamp: event.timestamp,
      },
      append: [],
    };
  }

  if (event.type === "execution_complete") {
    return {
      pending: null,
      append: pending ? [pendingToTokenEvent(pending), event] : [event],
    };
  }

  return { pending, append: [event] };
}

export function pendingToTokenEvent(pending: PendingAssistantText): AssistantTokenEvent {
  return { type: "token", ...pending };
}

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

function narrowDimensions(value: unknown): { width: number; height: number } | undefined {
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { width?: unknown }).width === "number" &&
    typeof (value as { height?: unknown }).height === "number"
  ) {
    return value as { width: number; height: number };
  }
  return undefined;
}

export function toUiArtifact(artifact: SessionArtifact): Artifact {
  const meta = artifact.metadata as Record<string, unknown> | null;
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
