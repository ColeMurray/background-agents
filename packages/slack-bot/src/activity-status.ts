import type { SlackEnvelope } from "@open-inspect/shared";
import { createLogger } from "./logger";
import type { Env } from "./types";

const SLACK_SET_STATUS_URL = "https://slack.com/api/assistant.threads.setStatus";
const DEFAULT_STATUS_PART_MAX_LENGTH = 80;

const log = createLogger("activity-status");

type AssistantStatusMeta = {
  event: "start" | "tool_call";
  traceId?: string;
  sessionId?: string;
  tool?: string;
  callId?: string;
};

function valueToText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function normalizeStatusText(value: unknown): string {
  return valueToText(value)
    .replace(/<!subteam\^[^>|]+(?:\|([^>]+))?>/g, (_match, label: string | undefined) => {
      return label || "subteam";
    })
    .replace(/<!([a-zA-Z_]+)(?:\|[^>]*)?>/g, "$1")
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<#([A-Z0-9]+)(?:\|([^>]+))?>/g, (_match, id: string, label: string | undefined) => {
      return `#${label || id}`;
    })
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncateStatusPart(
  value: unknown,
  maxLength = DEFAULT_STATUS_PART_MAX_LENGTH
): string {
  const text = normalizeStatusText(value);
  if (text.length <= maxLength) return text;
  if (maxLength <= 3) return ".".repeat(Math.max(0, maxLength));
  return `${text.slice(0, maxLength - 3)}...`;
}

function firstArg(args: Record<string, unknown>, keys: string[], fallback: string): string {
  for (const key of keys) {
    const value = args[key];
    const text = truncateStatusPart(value);
    if (text) return text;
  }
  return fallback;
}

export function formatToolStatus(tool: string, args: Record<string, unknown> = {}): string {
  const normalizedTool = normalizeStatusText(tool);
  const toolKey = normalizedTool.toLowerCase();

  switch (toolKey) {
    case "read":
    case "read_file":
      return `Reading ${firstArg(args, ["file_path", "filepath", "path", "file"], "file")}`;
    case "edit":
    case "edit_file":
      return `Editing ${firstArg(args, ["file_path", "filepath", "path", "file"], "file")}`;
    case "write":
    case "write_file":
      return `Writing ${firstArg(args, ["file_path", "filepath", "path", "file"], "file")}`;
    case "bash":
    case "execute_command":
      return `Running ${firstArg(args, ["command", "cmd"], "command")}`;
    case "grep":
    case "search_files":
      return `Searching for ${firstArg(args, ["pattern", "query"], "query")}`;
    default:
      return `Using tool: ${truncateStatusPart(normalizedTool || "unknown")}`;
  }
}

export async function setAssistantThreadStatus(
  token: string,
  channel: string,
  threadTs: string,
  status: string
): Promise<SlackEnvelope> {
  let response: Response;
  try {
    response = await fetch(SLACK_SET_STATUS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel_id: channel,
        thread_ts: threadTs,
        status,
      }),
    });
  } catch {
    return { ok: false, error: "network_error" };
  }

  if (response.status === 429) {
    const retryHeader = response.headers.get("retry-after");
    const retryAfter = retryHeader ? parseInt(retryHeader, 10) : NaN;
    return {
      ok: false,
      error: "ratelimited",
      ...(Number.isFinite(retryAfter) ? { retryAfter } : {}),
    };
  }

  if (!response.ok) {
    return { ok: false, error: `http_${response.status}` };
  }

  try {
    const envelope = (await response.json()) as SlackEnvelope;
    if (typeof envelope.ok !== "boolean") {
      return { ok: false, error: "invalid_response" };
    }
    return envelope;
  } catch {
    return { ok: false, error: "invalid_response" };
  }
}

export async function setAssistantThreadStatusBestEffort(
  env: Env,
  channel: string,
  threadTs: string,
  status: string,
  meta: AssistantStatusMeta
): Promise<void> {
  const startTime = Date.now();
  const eventName =
    meta.event === "tool_call"
      ? "slack.assistant_status.tool_call"
      : "slack.assistant_status.start";
  const base = {
    trace_id: meta.traceId,
    session_id: meta.sessionId,
    tool: meta.tool,
    call_id: meta.callId,
    channel,
    thread_ts: threadTs,
  };

  try {
    const result = await setAssistantThreadStatus(env.SLACK_BOT_TOKEN, channel, threadTs, status);
    if (result.ok) {
      log.info(eventName, {
        ...base,
        outcome: "success",
        duration_ms: Date.now() - startTime,
      });
      return;
    }

    log.warn(eventName, {
      ...base,
      outcome: "error",
      slack_error: result.error,
      retry_after: result.retryAfter,
      duration_ms: Date.now() - startTime,
    });
  } catch (error) {
    log.warn(eventName, {
      ...base,
      outcome: "error",
      error: error instanceof Error ? error : new Error(String(error)),
      duration_ms: Date.now() - startTime,
    });
  }
}
