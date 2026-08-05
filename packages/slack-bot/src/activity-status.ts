import { z } from "zod";
import { createLogger } from "./logger";
import type { Env } from "./types";

const SLACK_SET_STATUS_URL = "https://slack.com/api/assistant.threads.setStatus";
const DEFAULT_STATUS_PART_MAX_LENGTH = 80;
const DEFAULT_STATUS_TEXT_MAX_LENGTH = 80;
const LOADING_MESSAGE_MAX_LENGTH = 50;
const FILE_ARG_KEYS = ["filePath", "file_path", "filepath", "path", "file"];
const TOOL_STATUS_INDICATOR = "Working...";

const log = createLogger("activity-status");

const slackSetStatusResponseSchema = z
  .object({
    ok: z.boolean(),
    error: z.string().optional(),
    retryAfter: z.number().optional(),
    detail: z.unknown().optional(),
    response_metadata: z.unknown().optional(),
    warning: z.unknown().optional(),
    warnings: z.unknown().optional(),
  })
  .passthrough();

type AssistantThreadStatusOptions = {
  loadingMessages?: string[];
};

type AssistantThreadStatusResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      retryAfter?: number;
      detail?: unknown;
      responseMetadata?: unknown;
      warning?: unknown;
    };

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

function prepareStatusText(value: unknown): string {
  return truncateStatusPart(value, DEFAULT_STATUS_TEXT_MAX_LENGTH);
}

function prepareLoadingMessageText(value: unknown): string {
  return truncateStatusPart(value, LOADING_MESSAGE_MAX_LENGTH);
}

function firstArg(args: Record<string, unknown>, keys: string[], fallback: string): string {
  for (const key of keys) {
    const value = args[key];
    const text = truncateStatusPart(value);
    if (text) return text;
  }
  return fallback;
}

function compactPathPart(value: unknown, maxLength: number): string {
  const text = normalizeStatusText(value);
  if (!text) return "";

  const normalized = text.replace(/\\/g, "/").replace(/^\/workspace\/[^/]+\//, "");
  if (normalized.length <= maxLength) return normalized;

  const parts = normalized.split("/").filter(Boolean);
  for (let count = Math.min(3, parts.length); count > 0; count -= 1) {
    const tail = parts.slice(-count).join("/");
    if (tail.length <= maxLength) return tail;
  }

  return truncateStatusPart(parts.at(-1) ?? normalized, maxLength);
}

function fileArg(args: Record<string, unknown>, prefix: string, fallback: string): string {
  const maxLength = LOADING_MESSAGE_MAX_LENGTH - prefix.length - 1;
  for (const key of FILE_ARG_KEYS) {
    const text = compactPathPart(args[key], maxLength);
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
      return `Reading ${fileArg(args, "Reading", "file")}`;
    case "edit":
    case "edit_file":
      return `Editing ${fileArg(args, "Editing", "file")}`;
    case "write":
    case "write_file":
      return `Writing ${fileArg(args, "Writing", "file")}`;
    case "bash":
    case "execute_command":
      return `Running ${firstArg(args, ["command", "cmd"], "command")}`;
    case "grep":
    case "search_files":
      return `Searching for ${firstArg(args, ["pattern", "query"], "query")}`;
    case "glob":
      return `Finding ${firstArg(args, ["pattern", "query"], "files")}`;
    default:
      return `Using tool: ${truncateStatusPart(normalizedTool || "unknown")}`;
  }
}

export async function setAssistantThreadStatus(
  token: string,
  channel: string,
  threadTs: string,
  status: string,
  options: AssistantThreadStatusOptions = {}
): Promise<AssistantThreadStatusResult> {
  let response: Response;
  const normalizedStatus = prepareStatusText(status);
  const loadingMessages = options.loadingMessages
    ?.map((message) => prepareLoadingMessageText(message))
    .filter(Boolean)
    .slice(0, 10);

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
        status: normalizedStatus,
        ...(loadingMessages?.length ? { loading_messages: loadingMessages } : {}),
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
    const parsed = slackSetStatusResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return { ok: false, error: "invalid_response" };
    }
    const envelope = parsed.data;
    if (!envelope.ok) {
      if (!envelope.error) {
        return { ok: false, error: "invalid_response" };
      }
      return {
        ok: false,
        error: envelope.error,
        ...(envelope.retryAfter ? { retryAfter: envelope.retryAfter } : {}),
        ...(envelope.detail ? { detail: envelope.detail } : {}),
        ...(envelope.response_metadata ? { responseMetadata: envelope.response_metadata } : {}),
        ...(envelope.warning || envelope.warnings
          ? { warning: envelope.warning ?? envelope.warnings }
          : {}),
      };
    }
    return { ok: true };
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
    const statusText = meta.event === "tool_call" ? TOOL_STATUS_INDICATOR : status;
    const requestStatusLength = prepareStatusText(statusText).length;
    const requestLoadingMessageLengths = [status].map(
      (message) => prepareLoadingMessageText(message).length
    );
    const result = await setAssistantThreadStatus(
      env.SLACK_BOT_TOKEN,
      channel,
      threadTs,
      statusText,
      {
        loadingMessages: [status],
      }
    );

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
      slack_detail: result.detail,
      slack_response_metadata: result.responseMetadata,
      slack_warning: result.warning,
      retry_after: result.retryAfter,
      request_status_length: requestStatusLength,
      request_loading_message_count: requestLoadingMessageLengths.length,
      request_loading_message_lengths: requestLoadingMessageLengths,
      raw_status_length: normalizeStatusText(statusText).length,
      raw_loading_message_lengths: [status].map((message) => normalizeStatusText(message).length),
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
