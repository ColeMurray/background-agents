import { createKvCacheStore } from "@open-inspect/shared";
import { createLogger } from "../logger";
import { targetId, targetLabel, type SlackSessionTarget } from "../targets";
import type { Env, ThreadSession } from "../types";

const log = createLogger("handler");
const THREAD_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function getThreadSessionKey(channel: string, threadTs: string): string {
  return `thread:${channel}:${threadTs}`;
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
    return data && typeof data === "object" ? (data as ThreadSession) : null;
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
    await createKvCacheStore(env.SLACK_KV).put(
      getThreadSessionKey(channel, threadTs),
      JSON.stringify(session),
      { expirationTtl: THREAD_SESSION_TTL_SECONDS }
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

export function buildThreadSession(
  sessionId: string,
  target: SlackSessionTarget,
  model: string,
  reasoningEffort?: string
): ThreadSession {
  return {
    sessionId,
    repoId: targetId(target),
    repoFullName: targetLabel(target),
    model,
    reasoningEffort,
    createdAt: Date.now(),
  };
}
