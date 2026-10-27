/**
 * Bot identity resolution.
 *
 * Channel-trigger processing needs the bot's own Slack user id to strip and
 * suppress its own mentions, and its bot id to recognise its own posts. One
 * `auth.test` call returns both; we cache them, since they are effectively
 * static for the lifetime of the Slack app.
 */

import { authTest } from "@open-inspect/shared/slack";
import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import type { Env } from "./types";
import { createLogger } from "./logger";

const log = createLogger("bot-identity");

const BOT_USER_ID_KV_KEY = "slack:bot-user-id";
const BOT_ID_KV_KEY = "slack:bot-id";

/** Bot identity is effectively static; cache it for an hour in-process. */
const BOT_IDENTITY_TTL_MS = 60 * 60 * 1000;

/** The bot's own Slack ids. */
export interface BotIdentity {
  userId: string;
  /** Null when Slack did not report one; callers then drop every bot message. */
  botId: string | null;
}

let identityCache: { identity: BotIdentity; timestamp: number } | null = null;

/**
 * Resolve the bot's own Slack ids via `auth.test`, cached in-process and in KV
 * as last-known-good.
 *
 * Returns `null` when the user id cannot be determined (auth.test failed and no
 * KV copy exists). The caller fails **closed** and skips channel-trigger
 * processing in that case — mention suppression and self-mention stripping both
 * require a known id, so it is never safe to proceed without one.
 */
export async function getBotIdentity(env: Env, traceId?: string): Promise<BotIdentity | null> {
  if (identityCache && Date.now() - identityCache.timestamp < BOT_IDENTITY_TTL_MS) {
    return identityCache.identity;
  }

  const kv = createKvCacheStore(env.SLACK_KV);
  const result = await authTest(env.SLACK_BOT_TOKEN);
  if (result.ok && result.user_id) {
    const identity = { userId: result.user_id, botId: result.bot_id ?? null };
    identityCache = { identity, timestamp: Date.now() };
    try {
      await Promise.all([
        kv.put(BOT_USER_ID_KV_KEY, identity.userId),
        identity.botId ? kv.put(BOT_ID_KV_KEY, identity.botId) : undefined,
      ]);
    } catch (e) {
      log.warn("kv.put", {
        key_prefix: "bot_identity",
        error: e instanceof Error ? e : new Error(String(e)),
      });
    }
    return identity;
  }

  log.warn("slack.auth_test", {
    trace_id: traceId,
    outcome: "error",
    error: result.ok ? "missing_user_id" : result.error,
  });

  // Last-known-good from KV — the ids never really change, so a stale copy is
  // safe to serve through a transient auth.test failure. The ids are read
  // independently: only bot-message self-exclusion needs the bot id, so a
  // missing or unreadable one must not stop triggers from people.
  const [userId, botId] = await Promise.all([
    readStoredId(kv, BOT_USER_ID_KV_KEY),
    readStoredId(kv, BOT_ID_KV_KEY),
  ]);
  if (!userId) return null;
  const identity = { userId, botId };
  identityCache = { identity, timestamp: Date.now() };
  return identity;
}

/** A last-known-good id from KV, or null when it is absent or cannot be read. */
async function readStoredId(
  kv: ReturnType<typeof createKvCacheStore>,
  key: string
): Promise<string | null> {
  try {
    return (await kv.get(key)) ?? null;
  } catch (e) {
    log.warn("kv.get", {
      key_prefix: key,
      error: e instanceof Error ? e : new Error(String(e)),
    });
    return null;
  }
}

/** Clear the in-memory bot identity cache (for tests and forced refresh). */
export function clearBotIdentityCache(): void {
  identityCache = null;
}
