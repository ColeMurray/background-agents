/**
 * Live progress in the task thread.
 *
 * Each prompt gets one status message that is edited in place as the control
 * plane reports tool calls (at most one callback every few seconds), then
 * marked finished on completion. The message id and start time travel in the
 * prompt's callback context, so a follow-up sent while a prompt runs cannot be
 * confused with it.
 *
 * Tool-call and completion edits run in separate requests with no ordering, so
 * finishing records the final text in KV first. A step that sees it restores
 * that text, and one already in flight puts the final text back afterwards.
 */

import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import { formatToolStatus } from "@open-inspect/shared/completion/tool-status";
import type { DiscordStatusMessage } from "@open-inspect/shared/types/session-api";
import { editChannelMessage, postChannelMessage, sendTypingIndicator } from "./discord-api";
import { createLogger } from "./logger";
import type { Env } from "./types";

const log = createLogger("progress");

/** Outlives the control plane's last tool-call callback for a prompt. */
const FINISHED_MARKER_TTL_MS = 60 * 60 * 1000;
const MAX_STEP_LENGTH = 120;
export const PUBLICATION_STOPPED_TEXT = "**Updates stopped**";

function finishedKey(statusMessage: DiscordStatusMessage): string {
  return `status-finished:${statusMessage.id}`;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** One readable line per tool call; Discord markup and limits remain local. */
export function describeStep(tool: string, args: Record<string, unknown>): string {
  return formatToolStatus(tool, args, {
    argumentMaxLength: MAX_STEP_LENGTH,
    fileStatusMaxLength: MAX_STEP_LENGTH,
  })
    .replace(/`/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_STEP_LENGTH);
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
    const store = createKvCacheStore(env.DISCORD_KV);
    const previous = await store.get(finishedKey(statusMessage));
    if (previous !== null) {
      // Repair a failed finish edit (or a late in-flight tool edit), not just skip this step.
      await editChannelMessage(env.DISCORD_BOT_TOKEN, channelId, statusMessage.id, {
        content: previous,
      });
      return;
    }
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
    const finished = await store.get(finishedKey(statusMessage));
    if (finished !== null) {
      await editChannelMessage(env.DISCORD_BOT_TOKEN, channelId, statusMessage.id, {
        content: finished,
      });
    }
  } catch (error) {
    log.warn("progress.step_failed", { channel_id: channelId, error });
  }
}

/** Persist before editing; failures propagate so the callback can be retried. */
export async function stopPublication(
  env: Env,
  params: { channelId: string; statusMessage: DiscordStatusMessage }
): Promise<void> {
  await createKvCacheStore(env.DISCORD_KV).put(
    finishedKey(params.statusMessage),
    PUBLICATION_STOPPED_TEXT,
    {
      ttlMs: FINISHED_MARKER_TTL_MS,
    }
  );
  await editChannelMessage(env.DISCORD_BOT_TOKEN, params.channelId, params.statusMessage.id, {
    content: PUBLICATION_STOPPED_TEXT,
  });
}

/** Mark the status message finished. Never throws. */
export async function finishProgress(
  env: Env,
  params: { channelId: string; statusMessage: DiscordStatusMessage; success: boolean }
): Promise<void> {
  const { channelId, statusMessage } = params;
  const content = formatFinished(statusMessage.startedAt, params.success, Date.now());
  try {
    await createKvCacheStore(env.DISCORD_KV).put(finishedKey(statusMessage), content, {
      ttlMs: FINISHED_MARKER_TTL_MS,
    });
  } catch (error) {
    // Without the marker a late step may still win; the finish edit must go out regardless.
    log.warn("progress.finish_marker_failed", { channel_id: channelId, error });
  }
  try {
    await editChannelMessage(env.DISCORD_BOT_TOKEN, channelId, statusMessage.id, { content });
  } catch (error) {
    log.warn("progress.finish_failed", { channel_id: channelId, error });
  }
}
