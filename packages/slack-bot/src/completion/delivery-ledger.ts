import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import { createLogger } from "../logger";
import type { Env } from "../types";
import { slackCompletionDeliveryId } from "./job";

const log = createLogger("completion-ledger");

/**
 * How long a delivery marker suppresses a callback retry or queue redelivery.
 * Longer than the completion queue's single retry, and short enough that the
 * marker does not accumulate.
 */
export const SLACK_COMPLETION_DELIVERY_TTL_MS = 24 * 60 * 60 * 1000;

const LEDGER_KEY_PREFIX = "slack-completion-delivery:";
const KV_KEY_MAX_BYTES = 512;

export type CompletionDeliveryPhase = "missing" | "enqueued" | "posted" | "unavailable";

function ledgerKey(sessionId: string, messageId: string): string | null {
  const key = `${LEDGER_KEY_PREFIX}${slackCompletionDeliveryId(sessionId, messageId)}`;
  if (new TextEncoder().encode(key).length > KV_KEY_MAX_BYTES) return null;
  return key;
}

function logKvFailure(
  operation: "get" | "put",
  sessionId: string,
  messageId: string,
  error: unknown
): void {
  log.warn("slack.completion.ledger", {
    operation,
    session_id: sessionId,
    message_id: messageId,
    outcome: "unavailable",
    error: error instanceof Error ? error : new Error(String(error)),
  });
}

/**
 * Best-effort lookup. KV has no compare-and-swap, so two deliveries that both
 * observe `missing` can still both post. A read failure is `unavailable` and
 * must not be treated as a recorded delivery.
 */
export async function readCompletionDelivery(
  env: Env,
  sessionId: string,
  messageId: string
): Promise<CompletionDeliveryPhase> {
  const key = ledgerKey(sessionId, messageId);
  if (!key) return "unavailable";
  try {
    const value = await createKvCacheStore(env.SLACK_KV).get(key);
    if (value === "enqueued" || value === "posted") return value;
    return "missing";
  } catch (error) {
    logKvFailure("get", sessionId, messageId, error);
    return "unavailable";
  }
}

async function writePhase(
  env: Env,
  sessionId: string,
  messageId: string,
  phase: "enqueued" | "posted"
): Promise<void> {
  const key = ledgerKey(sessionId, messageId);
  if (!key) return;
  try {
    await createKvCacheStore(env.SLACK_KV).put(key, phase, {
      ttlMs: SLACK_COMPLETION_DELIVERY_TTL_MS,
    });
  } catch (error) {
    logKvFailure("put", sessionId, messageId, error);
  }
}

/** Records a queue handoff. Does not overwrite a marker that already exists. */
export async function recordCompletionEnqueued(
  env: Env,
  sessionId: string,
  messageId: string
): Promise<void> {
  const current = await readCompletionDelivery(env, sessionId, messageId);
  if (current !== "missing") return;
  await writePhase(env, sessionId, messageId, "enqueued");
}

/** Called only after Slack confirms the completion reply was posted. */
export async function recordCompletionPosted(
  env: Env,
  sessionId: string,
  messageId: string
): Promise<void> {
  await writePhase(env, sessionId, messageId, "posted");
}
