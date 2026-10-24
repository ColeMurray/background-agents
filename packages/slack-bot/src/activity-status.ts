import { z } from "zod";
import { formatToolStatus as formatSharedToolStatus } from "@open-inspect/shared/completion/tool-status";
import { createLogger } from "./logger";
import type { Env } from "./types";
import { isThreadSessionClosed, lookupThreadSession } from "./sessions/thread-session-store";

const SLACK_SET_STATUS_URL = "https://slack.com/api/assistant.threads.setStatus";
const DEFAULT_STATUS_PART_MAX_LENGTH = 80;
const DEFAULT_STATUS_TEXT_MAX_LENGTH = 80;
const LOADING_MESSAGE_MAX_LENGTH = 50;
/** The indicator Slack shows while a turn is in flight, whatever the turn is doing. */
export const ASSISTANT_WORKING_STATUS = "Working...";

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
  event: "start" | "tool_call" | "refresh";
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

export function formatToolStatus(tool: string, args: Record<string, unknown> = {}): string {
  return formatSharedToolStatus(tool, args, {
    normalizeText: normalizeStatusText,
    argumentMaxLength: DEFAULT_STATUS_PART_MAX_LENGTH,
    fileStatusMaxLength: LOADING_MESSAGE_MAX_LENGTH,
  });
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
      : meta.event === "refresh"
        ? "slack.assistant_status.refresh"
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
    const closed = meta.sessionId
      ? await isThreadSessionClosed(env, channel, threadTs, meta.sessionId)
      : (await lookupThreadSession(env, channel, threadTs))?.closed;
    if (closed) return;
    const statusText = meta.event === "tool_call" ? ASSISTANT_WORKING_STATUS : status;
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
