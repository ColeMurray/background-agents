import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import { compareSlackTimestamps } from "@open-inspect/shared/slack";
import { z } from "zod";
import { createLogger } from "../logger";
import { targetId, targetLabel, type SlackSessionTarget } from "../targets";
import type { Env, ThreadSession } from "../types";

const log = createLogger("handler");
const THREAD_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const threadSessionSchema: z.ZodType<ThreadSession> = z.object({
  sessionId: z.string().min(1),
  repoId: z.string().min(1),
  repoFullName: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
  createdAt: z.number().finite().nonnegative(),
  lastPromptTs: z.string().min(1).optional(),
});

function getThreadSessionKey(channel: string, threadTs: string): string {
  return `thread:${channel}:${threadTs}`;
}

/**
 * Read a thread's mapping, telling a failed read (`ok: false`) apart from an
 * absent one (`session: null`). Callers that must not overwrite a mapping
 * they could not see need the difference.
 */
export async function readThreadSession(
  env: Env,
  channel: string,
  threadTs: string
): Promise<{ ok: true; session: ThreadSession | null } | { ok: false }> {
  try {
    const data = await createKvCacheStore(env.SLACK_KV).get(
      getThreadSessionKey(channel, threadTs),
      "json"
    );
    const result = threadSessionSchema.safeParse(data);
    return { ok: true, session: result.success ? result.data : null };
  } catch (e) {
    log.error("kv.get", {
      key_prefix: "thread",
      channel,
      thread_ts: threadTs,
      error: e instanceof Error ? e : new Error(String(e)),
    });
    return { ok: false };
  }
}

export async function lookupThreadSession(
  env: Env,
  channel: string,
  threadTs: string
): Promise<ThreadSession | null> {
  const result = await readThreadSession(env, channel, threadTs);
  return result.ok ? result.session : null;
}

/** Resolves false when the write failed; the failure is already logged. */
export async function storeThreadSession(
  env: Env,
  channel: string,
  threadTs: string,
  session: ThreadSession
): Promise<boolean> {
  try {
    await createKvCacheStore(env.SLACK_KV).put(
      getThreadSessionKey(channel, threadTs),
      JSON.stringify(session),
      { expirationTtl: THREAD_SESSION_TTL_MS / 1000 }
    );
    return true;
  } catch (e) {
    log.error("kv.put", {
      key_prefix: "thread",
      channel,
      thread_ts: threadTs,
      error: e instanceof Error ? e : new Error(String(e)),
    });
    return false;
  }
}

export async function clearThreadSession(
  env: Env,
  channel: string,
  threadTs: string
): Promise<void> {
  try {
    await createKvCacheStore(env.SLACK_KV).delete(getThreadSessionKey(channel, threadTs));
  } catch (e) {
    log.error("kv.delete", {
      key_prefix: "thread",
      channel,
      thread_ts: threadTs,
      error: e instanceof Error ? e : new Error(String(e)),
    });
  }
}

/**
 * Advance the thread mapping's lastPromptTs checkpoint. Concurrent follow-ups
 * can complete out of order, and an older one must not move the checkpoint
 * backwards or later prompts would re-include already-forwarded context, so
 * the mapping is re-read and only written when the new ts is strictly newer.
 * KV has no compare-and-swap, so truly simultaneous writes can still race in
 * a narrow window; a lost race only re-includes a few already-forwarded
 * thread messages in a later prompt. No-op when the mapping is gone (e.g.
 * concurrently cleared) so a dead session is never resurrected.
 */
export async function advanceLastPromptTs(
  env: Env,
  channel: string,
  threadTs: string,
  promptTs: string
): Promise<void> {
  const current = await lookupThreadSession(env, channel, threadTs);
  if (!current) return;
  if (current.lastPromptTs && compareSlackTimestamps(current.lastPromptTs, promptTs) >= 0) return;
  await storeThreadSession(env, channel, threadTs, { ...current, lastPromptTs: promptTs });
}

export function buildThreadSession(
  sessionId: string,
  target: SlackSessionTarget,
  model: string,
  reasoningEffort?: string,
  lastPromptTs?: string
): ThreadSession {
  return {
    sessionId,
    repoId: targetId(target),
    repoFullName: targetLabel(target),
    model,
    reasoningEffort,
    createdAt: Date.now(),
    lastPromptTs,
  };
}
