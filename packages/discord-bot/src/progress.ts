/**
 * Live progress in the task thread.
 *
 * Each prompt gets one status message that is edited in place as the control
 * plane reports tool calls (at most one callback every 3 seconds), then
 * marked finished on completion. The record lives in KV keyed by session and
 * reply channel, since tool-call callbacks carry no message id.
 */

import { summarizeToolCall } from "@open-inspect/shared/completion/extractor";
import { z } from "zod";
import { editChannelMessage, postChannelMessage, sendTypingIndicator } from "./discord-api";
import { createLogger } from "./logger";
import type { Env } from "./types";

const log = createLogger("progress");

/**
 * Steps shown under the status line. The control plane throttles tool-call
 * callbacks, so these are a sample of recent steps, not a complete log.
 */
const VISIBLE_STEPS = 5;
/** Records outlive any realistic session; completion deletes them sooner. */
const STATUS_TTL_SECONDS = 24 * 60 * 60;

const statusRecordSchema = z.object({
  messageId: z.string(),
  startedAt: z.number(),
  recentSteps: z.array(z.string()),
});

type StatusRecord = z.infer<typeof statusRecordSchema>;

function statusKey(sessionId: string, channelId: string): string {
  return `status:${sessionId}:${channelId}`;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Shorten sandbox paths to their last segments so steps fit on one line. */
function shortenPaths(text: string): string {
  return text.replace(/(?:\/[\w.@-]+){3,}/g, (path) => `…/${path.split("/").slice(-2).join("/")}`);
}

/**
 * One readable line per tool call. Tool names are capitalized first because
 * OpenCode reports them in lowercase and the shared summarizer expects the
 * Claude spelling.
 */
export function describeStep(tool: string, args: Record<string, unknown>): string {
  const name = tool.charAt(0).toUpperCase() + tool.slice(1);
  const filePath = args.file_path ?? args.filePath;
  const { summary } = summarizeToolCall({
    tool: name,
    args: filePath === undefined ? args : { ...args, file_path: filePath },
  });
  return shortenPaths(summary).replace(/`/g, "'").slice(0, 120);
}

export function formatStatus(record: StatusRecord, now: number): string {
  const header = `⏳ **Working…** ${formatElapsed(now - record.startedAt)}`;
  if (record.recentSteps.length === 0) return `${header}\n-# Starting the sandbox`;
  return [header, ...record.recentSteps.map((step) => `-# ${step}`)].join("\n");
}

export function formatFinished(record: StatusRecord, success: boolean, now: number): string {
  const icon = success ? "✅ **Finished**" : "⚠️ **Stopped**";
  return `${icon} in ${formatElapsed(now - record.startedAt)}`;
}

async function readRecord(
  env: Env,
  sessionId: string,
  channelId: string
): Promise<StatusRecord | null> {
  const parsed = statusRecordSchema.safeParse(
    await env.DISCORD_KV.get(statusKey(sessionId, channelId), "json")
  );
  return parsed.success ? parsed.data : null;
}

async function writeRecord(
  env: Env,
  sessionId: string,
  channelId: string,
  record: StatusRecord
): Promise<void> {
  await env.DISCORD_KV.put(statusKey(sessionId, channelId), JSON.stringify(record), {
    expirationTtl: STATUS_TTL_SECONDS,
  });
}

/** Post the status message for a newly sent prompt. Never throws. */
export async function startProgress(env: Env, sessionId: string, channelId: string): Promise<void> {
  try {
    const record: StatusRecord = {
      messageId: "",
      startedAt: Date.now(),
      recentSteps: [],
    };
    record.messageId = await postChannelMessage(env.DISCORD_BOT_TOKEN, channelId, {
      content: formatStatus(record, record.startedAt),
    });
    await writeRecord(env, sessionId, channelId, record);
  } catch (error) {
    log.warn("progress.start_failed", { session_id: sessionId, error });
  }
}

/** Record one tool call and refresh the status message. Never throws. */
export async function recordStep(
  env: Env,
  params: { sessionId: string; channelId: string; tool: string; args: Record<string, unknown> }
): Promise<void> {
  const { sessionId, channelId } = params;
  try {
    const record = await readRecord(env, sessionId, channelId);
    // No record means the task already finished or its status post failed.
    if (!record) return;

    record.recentSteps = [...record.recentSteps, describeStep(params.tool, params.args)].slice(
      -VISIBLE_STEPS
    );
    await writeRecord(env, sessionId, channelId, record);

    await Promise.all([
      editChannelMessage(env.DISCORD_BOT_TOKEN, channelId, record.messageId, {
        content: formatStatus(record, Date.now()),
      }),
      sendTypingIndicator(env.DISCORD_BOT_TOKEN, channelId),
    ]);
  } catch (error) {
    log.warn("progress.step_failed", { session_id: sessionId, error });
  }
}

/** Mark the status message finished and forget it. Never throws. */
export async function finishProgress(
  env: Env,
  params: { sessionId: string; channelId: string; success: boolean }
): Promise<void> {
  const { sessionId, channelId } = params;
  try {
    const record = await readRecord(env, sessionId, channelId);
    if (!record) return;
    await env.DISCORD_KV.delete(statusKey(sessionId, channelId));
    await editChannelMessage(env.DISCORD_BOT_TOKEN, channelId, record.messageId, {
      content: formatFinished(record, params.success, Date.now()),
    });
  } catch (error) {
    log.warn("progress.finish_failed", { session_id: sessionId, error });
  }
}
