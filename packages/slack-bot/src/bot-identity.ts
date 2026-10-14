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

/** Bot identity is effectively static; cache it for an hour in-process. */
const BOT_IDENTITY_TTL_MS = 60 * 60 * 1000;

type IdentityField = "user_id" | "bot_id";

/** KV key holding each id as last-known-good, and its log label. */
const IDENTITY_KV: Record<IdentityField, { key: string; logPrefix: string }> = {
  user_id: { key: "slack:bot-user-id", logPrefix: "bot_user_id" },
  bot_id: { key: "slack:bot-id", logPrefix: "bot_id" },
};

const identityCache: Record<IdentityField, { id: string; timestamp: number } | null> = {
  user_id: null,
  bot_id: null,
};

async function persist(env: Env, field: IdentityField, id: string): Promise<void> {
  identityCache[field] = { id, timestamp: Date.now() };
  try {
    await createKvCacheStore(env.SLACK_KV).put(IDENTITY_KV[field].key, id);
  } catch (e) {
    log.warn("kv.put", {
      key_prefix: IDENTITY_KV[field].logPrefix,
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
  if (cached && Date.now() - cached.timestamp < BOT_IDENTITY_TTL_MS) {
    return cached.id;
  }

  const result = await authTest(env.SLACK_BOT_TOKEN);
  if (result.ok) {
    // Keep both ids from the one call, so the other lookup costs nothing.
    if (result.user_id) await persist(env, "user_id", result.user_id);
    if (result.bot_id) await persist(env, "bot_id", result.bot_id);
    if (result[field]) return result[field];
  }

  log.warn("slack.auth_test", {
    trace_id: traceId,
    outcome: "error",
    error: result.ok ? `missing_${field}` : result.error,
  });

  // Last-known-good from KV — the id never really changes, so a stale copy is
  // safe to serve through a transient auth.test failure.
  try {
    const stored = await createKvCacheStore(env.SLACK_KV).get(IDENTITY_KV[field].key);
    if (stored) {
      identityCache[field] = { id: stored, timestamp: Date.now() };
      return stored;
    }
  } catch (e) {
    log.warn("kv.get", {
      key_prefix: IDENTITY_KV[field].logPrefix,
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
export function clearBotIdentityCache(): void {
  identityCache.user_id = null;
  identityCache.bot_id = null;
}
