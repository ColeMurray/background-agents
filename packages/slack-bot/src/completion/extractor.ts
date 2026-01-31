/**
 * Extract and aggregate agent response from control-plane events.
 */

import type {
  Env,
  EventResponse,
  ListEventsResponse,
  AgentResponse,
  ToolCallSummary,
  ArtifactInfo,
} from "../types";
import { generateInternalToken } from "../utils/internal";
import { createLogger } from "../logger";

const log = createLogger("extractor");

/**
 * Tool names to include in summary display.
 */
export const SUMMARY_TOOL_NAMES = ["Edit", "Write", "Bash", "Grep", "Read"] as const;

// Server-side limit for events API
const EVENTS_PAGE_LIMIT = 200;

/**
 * Fetch events for a message and aggregate them into a response.
 *
 * Events are filtered by messageId directly - the control-plane associates
 * all events (tokens, tool_calls, etc.) with our internal messageId when storing.
 */
export async function extractAgentResponse(
  env: Env,
  sessionId: string,
  messageId: string,
  traceId?: string
): Promise<AgentResponse> {
  const startTime = Date.now();
  const base = { trace_id: traceId, session_id: sessionId, message_id: messageId };
  try {
    // Build auth headers
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (env.INTERNAL_CALLBACK_SECRET) {
      const authToken = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET);
      headers["Authorization"] = `Bearer ${authToken}`;
    }
    if (traceId) {
      headers["x-trace-id"] = traceId;
    }

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

      const response = await env.CONTROL_PLANE.fetch(url.toString(), { headers });

      if (!response.ok) {
        log.error("control_plane.fetch_events", {
          ...base,
          outcome: "error",
          http_status: response.status,
          duration_ms: Date.now() - startTime,
        });
        return { textContent: "", toolCalls: [], artifacts: [], success: false };
      }

      const data = (await response.json()) as ListEventsResponse;
      allEvents.push(...data.events);
      cursor = data.hasMore ? data.cursor : undefined;
    } while (cursor);

    // Get the final text from the last token event
    // Token events contain cumulative text (not incremental deltas), so we only need the last one
    const tokenEvents = allEvents
      .filter((e): e is EventResponse & { type: "token" } => e.type === "token")
      .sort((a, b) => {
        const timeDiff = (a.createdAt as number) - (b.createdAt as number);
        if (timeDiff !== 0) return timeDiff;
        return a.id.localeCompare(b.id); // Stable secondary sort
      });
    const lastToken = tokenEvents[tokenEvents.length - 1];
    const textContent = lastToken ? String(lastToken.data.content ?? "") : "";

    // Extract tool calls
    const toolCalls: ToolCallSummary[] = allEvents
      .filter((e) => e.type === "tool_call")
      .map((e) => summarizeToolCall(e.data));

    // Extract artifacts (PRs, branches)
    const artifacts: ArtifactInfo[] = allEvents
      .filter((e) => e.type === "artifact")
      .map((e) => ({
        type: String(e.data.artifactType ?? "unknown"),
        url: String(e.data.url ?? ""),
        label: getArtifactLabel(e.data),
      }));

    // Check for completion event to get success status
    const completionEvent = allEvents.find((e) => e.type === "execution_complete");

    log.info("control_plane.fetch_events", {
      ...base,
      outcome: "success",
      event_count: allEvents.length,
      tool_call_count: toolCalls.length,
      artifact_count: artifacts.length,
      has_text: Boolean(textContent),
      duration_ms: Date.now() - startTime,
    });

    return {
      textContent,
      toolCalls,
      artifacts,
      success: Boolean(completionEvent?.data.success),
    };
  } catch (error) {
    log.error("control_plane.fetch_events", {
      ...base,
      outcome: "error",
      error: error instanceof Error ? error : new Error(String(error)),
      duration_ms: Date.now() - startTime,
    });
    return { textContent: "", toolCalls: [], artifacts: [], success: false };
  }
}

/**
 * Summarize a tool call for display.
 */
function summarizeToolCall(data: Record<string, unknown>): ToolCallSummary {
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
 * Get display label for an artifact.
 */
function getArtifactLabel(data: Record<string, unknown>): string {
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
