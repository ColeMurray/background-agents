/**
 * Bot identity resolution.
 *
 * Channel-trigger processing needs the bot's own Slack user id to strip and
 * suppress its own mentions, and its bot id to recognise its own posts. We
 * resolve both via `auth.test` and cache them — they are effectively static for
 * the lifetime of the Slack app.
 */

import { authTest } from "@open-inspect/shared/slack";
import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import type { Env } from "./types";
import { createLogger } from "./logger";

const log = createLogger("bot-identity");

const BOT_USER_ID_KV_KEY = "slack:bot-user-id";
const BOT_ID_KV_KEY = "slack:bot-id";

/** Bot identity is effectively static; cache it for an hour in-process. */
const BOT_USER_ID_TTL_MS = 60 * 60 * 1000;

type IdentityField = "user_id" | "bot_id";

interface CachedId {
  id: string;
  timestamp: number;
}

const identityCache: Record<IdentityField, CachedId | null> = { user_id: null, bot_id: null };

const KV_KEYS: Record<IdentityField, string> = {
  user_id: BOT_USER_ID_KV_KEY,
  bot_id: BOT_ID_KV_KEY,
};

const KEY_PREFIXES: Record<IdentityField, string> = { user_id: "bot_user_id", bot_id: "bot_id" };

async function persist(env: Env, field: IdentityField, id: string): Promise<void> {
  identityCache[field] = { id, timestamp: Date.now() };
  try {
    await createKvCacheStore(env.SLACK_KV).put(KV_KEYS[field], id);
  } catch (e) {
    log.warn("kv.put", {
      key_prefix: KEY_PREFIXES[field],
      error: e instanceof Error ? e : new Error(String(e)),
    });
  }
}

async function resolveIdentity(
  env: Env,
  field: IdentityField,
  traceId?: string
): Promise<string | null> {
  const cached = identityCache[field];
  if (cached && Date.now() - cached.timestamp < BOT_USER_ID_TTL_MS) {
    return cached.id;
  }

  const result = await authTest(env.SLACK_BOT_TOKEN);
  if (result.ok && result[field]) {
    await persist(env, field, result[field]);
    return result[field];
  }

  log.warn("slack.auth_test", {
    trace_id: traceId,
    outcome: "error",
    error: result.ok ? `missing_${field}` : result.error,
  });

  // Last-known-good from KV — the id never really changes, so a stale copy is
  // safe to serve through a transient auth.test failure.
  try {
    const stored = await createKvCacheStore(env.SLACK_KV).get(KV_KEYS[field]);
    if (stored) {
      identityCache[field] = { id: stored, timestamp: Date.now() };
      return stored;
    }
  } catch (e) {
    log.warn("kv.get", {
      key_prefix: KEY_PREFIXES[field],
      error: e instanceof Error ? e : new Error(String(e)),
    });
  }

  return null;
}

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
  return resolveIdentity(env, "user_id", traceId);
}

/**
 * Resolve the bot's own `bot_id` the same way. A post the bot makes without a
 * `user` carries only this id, so it is what recognises such a post as the
 * bot's own. Returns `null` when it cannot be determined; callers fail closed.
 */
export async function getBotId(env: Env, traceId?: string): Promise<string | null> {
  return resolveIdentity(env, "bot_id", traceId);
}

/** Clear the in-memory bot identity cache (for tests and forced refresh). */
export function clearBotUserIdCache(): void {
  identityCache.user_id = null;
  identityCache.bot_id = null;
}
