/**
 * Extract and aggregate agent response from control-plane events.
 *
 * Shared implementation used by slack-bot, linear-bot, and any future
 * consumer that needs to turn raw session events into a structured
 * AgentResponse.
 */

import type {
  ListArtifactsResponse,
  AgentResponse,
  ToolCallSummary,
  ArtifactInfo,
  MediaArtifactInfo,
} from "../types/artifacts";
import type { EventResponse, ListEventsResponse } from "../types/sandbox-events";
import type { ArtifactType } from "../types/statuses";
import type { Logger } from "../logger";
import { buildInternalAuthHeaders } from "../auth";

/**
 * Tool names included in summary display.
 */
export const SUMMARY_TOOL_NAMES = ["Edit", "Write", "Bash", "Grep", "Read"] as const;

/** Server-side limit for the events API. */
const EVENTS_PAGE_LIMIT = 200;

export interface BuildAgentResponseOptions {
  defaultSuccess?: boolean;
}

/**
 * Minimal interface for the control-plane service binding.
 * Compatible with Cloudflare Workers' `Fetcher` type without depending on
 * `@cloudflare/workers-types`.
 */
export interface ControlPlaneFetcher {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

/**
 * Dependencies injected into {@link extractAgentResponse} so it does not
 * depend on any package-specific `Env` type.
 */
export interface ExtractorDeps {
  /** Cloudflare Workers service binding pointing at the control plane (resolves `https://internal` URLs). */
  fetcher: ControlPlaneFetcher;
  /** Shared secret for HMAC-based internal auth. If omitted, requests are sent without auth. */
  internalSecret?: string;
  /** Structured logger. Falls back to a silent no-op if not provided. */
  log?: Logger;
}

/** Silent no-op logger used when the caller does not supply one. */
const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

/**
 * Fetch events for a message and aggregate them into a structured response.
 *
 * Events are filtered server-side by `messageId`. Token events contain
 * cumulative text, so only the last one is kept. Artifacts are fetched from
 * the dedicated `/artifacts` endpoint, falling back to inline artifact events
 * when the endpoint errors.
 */
export async function extractAgentResponse(
  deps: ExtractorDeps,
  sessionId: string,
  messageId: string,
  traceId?: string
): Promise<AgentResponse> {
  const log = deps.log ?? noopLogger;
  const startTime = Date.now();
  const base = { trace_id: traceId, session_id: sessionId, message_id: messageId };

  try {
    // Build auth headers
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(await buildInternalAuthHeaders(deps.internalSecret, traceId)),
    };

    // Fetch all events for this message, paginating if necessary
    const allEvents: EventResponse[] = [];
    let cursor: string | undefined;

    do {
      const url = new URL(`https://internal/sessions/${sessionId}/events`);
      url.searchParams.set("message_id", messageId);
      url.searchParams.set("limit", String(EVENTS_PAGE_LIMIT));
      if (cursor) {
        url.searchParams.set("cursor", cursor);
      }

      const response = await deps.fetcher.fetch(url.toString(), { headers });

      if (!response.ok) {
        log.error("control_plane.fetch_events", {
          ...base,
          outcome: "error",
          http_status: response.status,
          duration_ms: Date.now() - startTime,
        });
        return {
          textContent: "",
          toolCalls: [],
          artifacts: [],
          mediaArtifacts: [],
          success: false,
        };
      }

      const data = (await response.json()) as ListEventsResponse;
      allEvents.push(...data.events);
      cursor = data.hasMore ? data.cursor : undefined;
    } while (cursor);

    const artifacts = await fetchSessionArtifacts(deps, sessionId, headers, base, allEvents);
    const agentResponse = buildAgentResponseFromEvents(allEvents, artifacts);

    log.info("control_plane.fetch_events", {
      ...base,
      outcome: "success",
      event_count: allEvents.length,
      tool_call_count: agentResponse.toolCalls.length,
      artifact_count: agentResponse.artifacts.length,
      media_artifact_count: agentResponse.mediaArtifacts.length,
      has_text: Boolean(agentResponse.textContent),
      has_error: Boolean(agentResponse.error),
      duration_ms: Date.now() - startTime,
    });

    return agentResponse;
  } catch (error) {
    log.error("control_plane.fetch_events", {
      ...base,
      outcome: "error",
      error: error instanceof Error ? error : new Error(String(error)),
      duration_ms: Date.now() - startTime,
    });
    return { textContent: "", toolCalls: [], artifacts: [], mediaArtifacts: [], success: false };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Aggregate persisted control-plane events into the structured response shape
 * consumed by callbacks and child-session introspection.
 */
export function buildAgentResponseFromEvents(
  events: EventResponse[],
  artifacts: ArtifactInfo[] = [],
  options: BuildAgentResponseOptions = {}
): AgentResponse {
  const chronologicalEvents = sortEventsChronologically(events);

  // Token events contain cumulative text, so only the chronologically last one matters.
  const tokenEvents = chronologicalEvents.filter(
    (event): event is EventResponse & { type: "token" } => event.type === "token"
  );
  const lastToken = tokenEvents[tokenEvents.length - 1];
  const textContent = lastToken ? String(lastToken.data.content ?? "") : "";

  const toolCalls: ToolCallSummary[] = chronologicalEvents
    .filter((event) => event.type === "tool_call")
    .map((event) => summarizeToolCall(event.data));

  const eventArtifacts: ArtifactInfo[] = chronologicalEvents
    .filter((event) => event.type === "artifact")
    .map((event) => toEventArtifactInfo(event.data))
    .filter((artifact: ArtifactInfo | null): artifact is ArtifactInfo => artifact !== null);

  const mediaArtifacts: MediaArtifactInfo[] = [];
  const mediaArtifactIds = new Set<string>();
  for (const event of chronologicalEvents) {
    if (event.type !== "artifact") continue;
    const mediaArtifact = toEventMediaArtifactInfo(event.data);
    if (!mediaArtifact || mediaArtifactIds.has(mediaArtifact.id)) continue;
    mediaArtifactIds.add(mediaArtifact.id);
    mediaArtifacts.push(mediaArtifact);
  }

  const completionEvent = findLastEvent(chronologicalEvents, "execution_complete");
  const errorEvent = findLastEvent(chronologicalEvents, "error");
  const errorMessage =
    (completionEvent?.data.error != null ? String(completionEvent.data.error) : undefined) ??
    (errorEvent?.data.error != null ? String(errorEvent.data.error) : undefined);

  const successValue = completionEvent?.data.success;
  const success =
    typeof successValue === "boolean" ? successValue : (options.defaultSuccess ?? false);

  return {
    textContent,
    toolCalls,
    artifacts: eventArtifacts.length > 0 ? eventArtifacts : artifacts,
    mediaArtifacts,
    success,
    error: errorMessage,
  };
}

function sortEventsChronologically(events: EventResponse[]): EventResponse[] {
  return [...events].sort((a, b) => {
    const timeDiff = a.createdAt - b.createdAt;
    if (timeDiff !== 0) return timeDiff;
    return a.id.localeCompare(b.id);
  });
}

function findLastEvent(
  events: EventResponse[],
  type: EventResponse["type"]
): EventResponse | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === type) return events[index];
  }
  return undefined;
}

/**
 * Fetch artifacts from the control-plane `/artifacts` endpoint.
 */
async function fetchSessionArtifacts(
  deps: ExtractorDeps,
  sessionId: string,
  headers: Record<string, string>,
  base: Record<string, unknown>,
  events: EventResponse[]
): Promise<ArtifactInfo[]> {
  const log = deps.log ?? noopLogger;
  const eventRange = getEventCreatedAtRange(events);
  try {
    const response = await deps.fetcher.fetch(`https://internal/sessions/${sessionId}/artifacts`, {
      headers,
    });

    if (!response.ok) {
      log.error("control_plane.fetch_artifacts", {
        ...base,
        outcome: "error",
        http_status: response.status,
      });
      return [];
    }

    const data = (await response.json()) as ListArtifactsResponse;
    return data.artifacts
      .filter((artifact) => artifact.type !== "screenshot" && artifact.type !== "video")
      .filter((artifact) => isArtifactInEventRange(artifact.createdAt, eventRange))
      .map((artifact) => ({
        type: artifact.type,
        url: artifact.url ? String(artifact.url) : "",
        label: getArtifactLabelFromArtifact(artifact.type, artifact.metadata),
        metadata: artifact.metadata ?? null,
      }));
  } catch (error) {
    log.error("control_plane.fetch_artifacts", {
      ...base,
      outcome: "error",
      error: error instanceof Error ? error : new Error(String(error)),
    });
    return [];
  }
}

function getEventCreatedAtRange(events: EventResponse[]): { start: number; end: number } | null {
  if (events.length === 0) return null;

  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    start = Math.min(start, event.createdAt);
    end = Math.max(end, event.createdAt);
  }

  return { start, end };
}

function isArtifactInEventRange(
  createdAt: number,
  range: { start: number; end: number } | null
): boolean {
  if (!range) return false;
  return createdAt >= range.start && createdAt <= range.end;
}

/**
 * Summarize a tool call for display.
 */
export function summarizeToolCall(data: Record<string, unknown>): ToolCallSummary {
  const tool = String(data.tool ?? "Unknown");
  const args = (data.args ?? {}) as Record<string, unknown>;

  switch (tool) {
    case "Read":
      return { tool, summary: `Read ${args.file_path ?? "file"}` };
    case "Edit":
      return { tool, summary: `Edited ${args.file_path ?? "file"}` };
    case "Write":
      return { tool, summary: `Created ${args.file_path ?? "file"}` };
    case "Bash": {
      const cmd = String(args.command ?? "").slice(0, 40);
      return { tool, summary: `Ran: ${cmd}${cmd.length >= 40 ? "..." : ""}` };
    }
    case "Grep":
      return { tool, summary: `Searched for "${args.pattern ?? ""}"` };
    default:
      return { tool, summary: `Used ${tool}` };
  }
}

/**
 * Get display label for an artifact from raw event data.
 */
export function getArtifactLabel(data: Record<string, unknown>): string {
  const type = String(data.artifactType ?? "artifact");
  if (type === "pr") {
    const metadata = data.metadata as Record<string, unknown> | undefined;
    const prNum = metadata?.number;
    return prNum ? `PR #${prNum}` : "Pull Request";
  }
  if (type === "branch") {
    const metadata = data.metadata as Record<string, unknown> | undefined;
    return `Branch: ${metadata?.name ?? "branch"}`;
  }
  return type;
}

/**
 * Get display label for an artifact fetched from the artifacts API.
 */
export function getArtifactLabelFromArtifact(
  type: ArtifactType,
  metadata: Record<string, unknown> | null
): string {
  if (type === "pr") {
    const prNum = metadata?.number;
    return prNum ? `PR #${prNum}` : "Pull Request";
  }
  if (type === "branch") {
    const branchName = metadata?.head;
    return `Branch: ${branchName ?? "branch"}`;
  }
  return type;
}

/**
 * Convert raw event data into an ArtifactInfo, returning null for unrecognized types.
 */
export function toEventArtifactInfo(data: Record<string, unknown>): ArtifactInfo | null {
  const type = toArtifactType(data.artifactType);
  if (!type || type === "screenshot" || type === "video") return null;

  return {
    type,
    url: String(data.url ?? ""),
    label: getArtifactLabel(data),
  };
}

/** Convert a media artifact event into the protected download information. */
export function toEventMediaArtifactInfo(data: Record<string, unknown>): MediaArtifactInfo | null {
  const type = toArtifactType(data.artifactType);
  if (type !== "screenshot" && type !== "video") return null;

  const id = typeof data.artifactId === "string" ? data.artifactId.trim() : "";
  if (!id) return null;

  const metadata =
    data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)
      ? (data.metadata as Record<string, unknown>)
      : undefined;
  const mimeType = typeof metadata?.mimeType === "string" ? metadata.mimeType : undefined;
  const sizeBytes =
    typeof metadata?.sizeBytes === "number" &&
    Number.isSafeInteger(metadata.sizeBytes) &&
    metadata.sizeBytes > 0
      ? metadata.sizeBytes
      : undefined;
  const caption = typeof metadata?.caption === "string" ? metadata.caption : undefined;

  return {
    id,
    type,
    ...(mimeType ? { mimeType } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(caption ? { caption } : {}),
  };
}

/**
 * Narrow an unknown value to a known ArtifactType or return null.
 */
export function toArtifactType(value: unknown): ArtifactType | null {
  return value === "pr" ||
    value === "screenshot" ||
    value === "video" ||
    value === "preview" ||
    value === "branch"
    ? value
    : null;
}
