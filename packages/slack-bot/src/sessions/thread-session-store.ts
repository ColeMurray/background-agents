import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import { compareSlackTimestamps } from "@open-inspect/shared/slack";
import { z } from "zod";
import { createLogger } from "../logger";
import { targetId, targetLabel, type SlackSessionTarget } from "../targets";
import type { Env, ThreadSession } from "../types";

const log = createLogger("handler");
export const THREAD_CLOSED_MESSAGE = "this session is no longer available from this channel";
const THREAD_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const threadSessionSchema: z.ZodType<ThreadSession> = z.object({
  sessionId: z.string().min(1),
  teamId: z.string().min(1).nullable().optional(),
  closed: z.literal(true).optional(),
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

function getThreadClosureKey(channel: string, threadTs: string, sessionId: string): string {
  return `thread-closed:${channel}:${threadTs}:${sessionId}`;
}

function getThreadClosureNoticeKey(channel: string, threadTs: string, sessionId: string): string {
  return `${getThreadClosureKey(channel, threadTs, sessionId)}:notice`;
}

function withoutClosure({ closed: _closed, ...session }: ThreadSession): ThreadSession {
  return session;
}

async function hasThreadClosure(
  env: Env,
  channel: string,
  threadTs: string,
  sessionId: string
): Promise<boolean> {
  return (
    (await createKvCacheStore(env.SLACK_KV).get(
      getThreadClosureKey(channel, threadTs, sessionId)
    )) === "1"
  );
}

export async function lookupThreadSession(
  env: Env,
  channel: string,
  threadTs: string
): Promise<ThreadSession | null> {
  try {
    const data = await createKvCacheStore(env.SLACK_KV).get(
      getThreadSessionKey(channel, threadTs),
      "json"
    );
    const result = threadSessionSchema.safeParse(data);
    if (!result.success) return null;
    const session = result.data;
    if (!session.closed && (await hasThreadClosure(env, channel, threadTs, session.sessionId))) {
      return { ...session, closed: true };
    }
    return session;
  } catch (e) {
    log.error("kv.get", {
      key_prefix: "thread",
      channel,
      thread_ts: threadTs,
      error: e instanceof Error ? e : new Error(String(e)),
    });
    return null;
  }
}

export async function storeThreadSession(
  env: Env,
  channel: string,
  threadTs: string,
  session: ThreadSession
): Promise<void> {
  try {
    if (!session.closed && (await hasThreadClosure(env, channel, threadTs, session.sessionId))) {
      session = { ...session, closed: true };
    }
    await createKvCacheStore(env.SLACK_KV).put(
      getThreadSessionKey(channel, threadTs),
      JSON.stringify(session),
      { expirationTtl: THREAD_SESSION_TTL_MS / 1000 }
    );
  } catch (e) {
    log.error("kv.put", {
      key_prefix: "thread",
      channel,
      thread_ts: threadTs,
      error: e instanceof Error ? e : new Error(String(e)),
    });
  }
}

/** Also checks coordinate-only closures, where an automation has no interactive mapping. */
export async function isThreadSessionClosed(
  env: Env,
  channel: string,
  threadTs: string,
  sessionId: string
): Promise<boolean> {
  const mapping = await lookupThreadSession(env, channel, threadTs);
  if (mapping?.sessionId === sessionId) return mapping.closed === true;
  return hasThreadClosure(env, channel, threadTs, sessionId);
}

/** The independent tombstone survives absent mappings and stale whole-record writes. */
export async function closeThreadSession(
  env: Env,
  channel: string,
  threadTs: string,
  sessionId: string
): Promise<void> {
  if (await hasThreadClosure(env, channel, threadTs, sessionId)) return;
  // Do not swallow marker failures: callback callers must return a retryable response.
  await createKvCacheStore(env.SLACK_KV).put(
    getThreadClosureKey(channel, threadTs, sessionId),
    "1",
    {
      expirationTtl: THREAD_SESSION_TTL_MS / 1000,
    }
  );
  const mapping = await lookupThreadSession(env, channel, threadTs);
  if (mapping?.sessionId === sessionId) {
    await storeThreadSession(env, channel, threadTs, { ...mapping, closed: true });
  }
}

/**
 * Lifts a closure after the caller re-verified the channel binding and publication access:
 * both can change back, so a closure must not outlive them. The tombstone goes first so the
 * mapping rewrite can drop `closed`; a closure written meanwhile wins through its own tombstone.
 */
export async function reopenThreadSession(
  env: Env,
  channel: string,
  threadTs: string,
  session: ThreadSession
): Promise<ThreadSession> {
  const store = createKvCacheStore(env.SLACK_KV);
  await store.delete(getThreadClosureKey(channel, threadTs, session.sessionId));
  await store.delete(getThreadClosureNoticeKey(channel, threadTs, session.sessionId));
  const mapping = await lookupThreadSession(env, channel, threadTs);
  if (mapping?.sessionId === session.sessionId && mapping.closed) {
    await storeThreadSession(env, channel, threadTs, withoutClosure(mapping));
  }
  return withoutClosure(session);
}

/** Best-effort sent-marker lookup, not an atomic delivery claim. */
export async function isThreadClosureNoticeSent(
  env: Env,
  channel: string,
  threadTs: string,
  sessionId: string
): Promise<boolean> {
  const key = getThreadClosureNoticeKey(channel, threadTs, sessionId);
  return (await createKvCacheStore(env.SLACK_KV).get(key)) === "1";
}

/** Called only after Slack confirms the notice was posted. */
export async function markThreadClosureNoticeSent(
  env: Env,
  channel: string,
  threadTs: string,
  sessionId: string
): Promise<void> {
  await createKvCacheStore(env.SLACK_KV).put(
    getThreadClosureNoticeKey(channel, threadTs, sessionId),
    "1",
    { expirationTtl: THREAD_SESSION_TTL_MS / 1000 }
  );
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
 * thread messages in a later prompt. No-op when the mapping is gone or closed;
 * the separate tombstone preserves closure across stale checkpoint writes.
 */
export async function advanceLastPromptTs(
  env: Env,
  channel: string,
  threadTs: string,
  promptTs: string
): Promise<void> {
  const current = await lookupThreadSession(env, channel, threadTs);
  if (!current || current.closed) return;
  if (current.lastPromptTs && compareSlackTimestamps(current.lastPromptTs, promptTs) >= 0) return;
  await storeThreadSession(env, channel, threadTs, { ...current, lastPromptTs: promptTs });
}

export function buildThreadSession(
  sessionId: string,
  target: SlackSessionTarget,
  model: string,
  reasoningEffort?: string,
  lastPromptTs?: string,
  teamId?: string | null
): ThreadSession {
  return {
    sessionId,
    repoId: targetId(target),
    repoFullName: targetLabel(target),
    model,
    reasoningEffort,
    createdAt: Date.now(),
    lastPromptTs,
    ...(teamId !== undefined ? { teamId } : {}),
  };
}
