/**
 * Bot identity resolution.
 *
 * Channel-trigger processing needs the bot's own Slack user id to strip and
 * suppress its own mentions. We resolve it once via `auth.test` and cache it —
 * the id is effectively static for the lifetime of the Slack app.
 */

import { authTest, createKvCacheStore } from "@open-inspect/shared";
import type { Env } from "./types";
import { createLogger } from "./logger";

const log = createLogger("bot-identity");

const BOT_USER_ID_KV_KEY = "slack:bot-user-id";

/** Bot identity is effectively static; cache it for an hour in-process. */
const BOT_USER_ID_TTL_MS = 60 * 60 * 1000;

let botUserIdCache: {
  id: string;
  timestamp: number;
} | null = null;

/**
 * Resolve the bot's own Slack user id via `auth.test`, cached in-process and in
 * KV as last-known-good.
 *
 * Returns `null` when the id cannot be determined (auth.test failed and no KV
 * copy exists). The caller fails **closed** and skips channel-trigger
 * processing in that case — mention suppression and self-mention stripping both
 * require a known id, so it is never safe to proceed without one.
 */
export async function getBotUserId(env: Env, traceId?: string): Promise<string | null> {
  if (botUserIdCache && Date.now() - botUserIdCache.timestamp < BOT_USER_ID_TTL_MS) {
    return botUserIdCache.id;
  }

  const result = await authTest(env.SLACK_BOT_TOKEN);
  if (result.ok && result.user_id) {
    botUserIdCache = { id: result.user_id, timestamp: Date.now() };
    try {
      await createKvCacheStore(env.SLACK_KV).put(BOT_USER_ID_KV_KEY, result.user_id);
    } catch (e) {
      log.warn("kv.put", {
        key_prefix: "bot_user_id",
        error: e instanceof Error ? e : new Error(String(e)),
      });
    }
    return result.user_id;
  }

  log.warn("slack.auth_test", {
    trace_id: traceId,
    outcome: "error",
    error: result.ok ? "missing_user_id" : result.error,
  });

  // Last-known-good from KV — the id never really changes, so a stale copy is
  // safe to serve through a transient auth.test failure.
  try {
    const cached = await createKvCacheStore(env.SLACK_KV).get(BOT_USER_ID_KV_KEY);
    if (cached) {
      botUserIdCache = { id: cached, timestamp: Date.now() };
      return cached;
    }
  } catch (e) {
    log.warn("kv.get", {
      key_prefix: "bot_user_id",
      error: e instanceof Error ? e : new Error(String(e)),
    });
  }

  return null;
}

/** Clear the in-memory bot-id cache (for tests and forced refresh). */
export function clearBotUserIdCache(): void {
  botUserIdCache = null;
}
