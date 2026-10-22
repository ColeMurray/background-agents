/**
 * Live progress in the task thread.
 *
 * Each prompt gets one status message that is edited in place as the control
 * plane reports tool calls (at most one callback every few seconds), then
 * marked finished on completion. The message id and start time travel in the
 * prompt's callback context, so the bot keeps no state of its own and a
 * follow-up sent while a prompt runs cannot be confused with it.
 */

import { summarizeToolCall } from "@open-inspect/shared/completion/extractor";
import type { DiscordStatusMessage } from "@open-inspect/shared/types/session-api";
import { editChannelMessage, postChannelMessage, sendTypingIndicator } from "./discord-api";
import { createLogger } from "./logger";
import type { Env } from "./types";

const log = createLogger("progress");

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Shorten sandbox paths to their last segments so steps fit on one line. */
function shortenPaths(text: string): string {
  return text.replace(/(?:\/[\w.@-]+){3,}/g, (path) => `…/${path.split("/").slice(-2).join("/")}`);
}

/** One readable line per tool call. */
export function describeStep(tool: string, args: Record<string, unknown>): string {
  const { summary } = summarizeToolCall({ tool, args });
  return shortenPaths(summary).replace(/`/g, "'").slice(0, 120);
}

/**
 * The status message while the agent works. The control plane throttles
 * tool-call callbacks, so the step shown is the latest sample, not a log.
 */
export function formatStatus(startedAt: number, step: string | undefined, now: number): string {
  const header = `⏳ **Working…** ${formatElapsed(now - startedAt)}`;
  return `${header}\n-# ${step ?? "Starting the sandbox"}`;
}

function formatFinished(startedAt: number, success: boolean, now: number): string {
  const icon = success ? "✅ **Finished**" : "⚠️ **Stopped**";
  return `${icon} in ${formatElapsed(now - startedAt)}`;
}

/**
 * Post the status message for a prompt about to be sent. Returns nothing when
 * Discord refuses; the prompt still goes out, just without live progress.
 */
export async function startProgress(
  env: Env,
  channelId: string
): Promise<DiscordStatusMessage | undefined> {
  const startedAt = Date.now();
  try {
    const id = await postChannelMessage(env.DISCORD_BOT_TOKEN, channelId, {
      content: formatStatus(startedAt, undefined, startedAt),
    });
    return { id, startedAt };
  } catch (error) {
    log.warn("progress.start_failed", { channel_id: channelId, error });
    return undefined;
  }
}

/** Show one tool call on the status message. Never throws. */
export async function recordStep(
  env: Env,
  params: {
    channelId: string;
    statusMessage: DiscordStatusMessage;
    tool: string;
    args: Record<string, unknown>;
  }
): Promise<void> {
  const { channelId, statusMessage } = params;
  try {
    await Promise.all([
      editChannelMessage(env.DISCORD_BOT_TOKEN, channelId, statusMessage.id, {
        content: formatStatus(
          statusMessage.startedAt,
          describeStep(params.tool, params.args),
          Date.now()
        ),
      }),
      sendTypingIndicator(env.DISCORD_BOT_TOKEN, channelId),
    ]);
  } catch (error) {
    log.warn("progress.step_failed", { channel_id: channelId, error });
  }
}

/** Mark the status message finished. Never throws. */
export async function finishProgress(
  env: Env,
  params: { channelId: string; statusMessage: DiscordStatusMessage; success: boolean }
): Promise<void> {
  const { channelId, statusMessage } = params;
  try {
    await editChannelMessage(env.DISCORD_BOT_TOKEN, channelId, statusMessage.id, {
      content: formatFinished(statusMessage.startedAt, params.success, Date.now()),
    });
  } catch (error) {
    log.warn("progress.finish_failed", { channel_id: channelId, error });
  }
}
