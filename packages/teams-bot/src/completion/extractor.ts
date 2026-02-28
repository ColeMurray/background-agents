/**
 * Extract and aggregate agent response from control-plane events.
 */

import type {
  Env,
  EventResponse,
  ListEventsResponse,
  ListArtifactsResponse,
  AgentResponse,
  ToolCallSummary,
  ArtifactInfo,
} from "../types";
import { generateInternalToken } from "../utils/internal";
import { createLogger } from "../logger";

const log = createLogger("extractor");

export const SUMMARY_TOOL_NAMES = ["Edit", "Write", "Bash", "Grep", "Read"] as const;

const EVENTS_PAGE_LIMIT = 200;

export async function extractAgentResponse(
  env: Env,
  sessionId: string,
  messageId: string,
  traceId?: string
): Promise<AgentResponse> {
  const startTime = Date.now();
  const base = { trace_id: traceId, session_id: sessionId, message_id: messageId };
  try {
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

    const tokenEvents = allEvents
      .filter((e): e is EventResponse & { type: "token" } => e.type === "token")
      .sort((a, b) => {
        const timeDiff = (a.createdAt as number) - (b.createdAt as number);
        if (timeDiff !== 0) return timeDiff;
        return a.id.localeCompare(b.id);
      });
    const lastToken = tokenEvents[tokenEvents.length - 1];
    const textContent = lastToken ? String(lastToken.data.content ?? "") : "";

    const toolCalls: ToolCallSummary[] = allEvents
      .filter((e) => e.type === "tool_call")
      .map((e) => summarizeToolCall(e.data));

    const eventArtifacts: ArtifactInfo[] = allEvents
      .filter((e) => e.type === "artifact")
      .map((e) => ({
        type: String(e.data.artifactType ?? "unknown"),
        url: String(e.data.url ?? ""),
        label: getArtifactLabel(e.data),
      }));

    const artifacts = await fetchSessionArtifacts(env, sessionId, headers, base);
    const finalArtifacts = artifacts.length > 0 ? artifacts : eventArtifacts;

    const completionEvent = allEvents.find((e) => e.type === "execution_complete");

    log.info("control_plane.fetch_events", {
      ...base,
      outcome: "success",
      event_count: allEvents.length,
      tool_call_count: toolCalls.length,
      artifact_count: finalArtifacts.length,
      has_text: Boolean(textContent),
      duration_ms: Date.now() - startTime,
    });

    return {
      textContent,
      toolCalls,
      artifacts: finalArtifacts,
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

async function fetchSessionArtifacts(
  env: Env,
  sessionId: string,
  headers: Record<string, string>,
  base: { trace_id: string | undefined; session_id: string; message_id: string }
): Promise<ArtifactInfo[]> {
  try {
    const response = await env.CONTROL_PLANE.fetch(
      `https://internal/sessions/${sessionId}/artifacts`,
      { headers }
    );

    if (!response.ok) {
      log.error("control_plane.fetch_artifacts", {
        ...base,
        outcome: "error",
        http_status: response.status,
      });
      return [];
    }

    const data = (await response.json()) as ListArtifactsResponse;
    return data.artifacts.map((artifact) => ({
      type: String(artifact.type ?? "unknown"),
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

function getArtifactLabelFromArtifact(
  type: string,
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
