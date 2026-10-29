import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import { createLogger } from "../logger";
import type { Env } from "../types";

const log = createLogger("completion-ledger");

/**
 * How long a delivery marker suppresses a callback retry or queue redelivery.
 * Longer than the completion queue's single retry, and short enough that the
 * marker does not accumulate.
 */
export const SLACK_COMPLETION_DELIVERY_TTL_MS = 24 * 60 * 60 * 1000;

const LEDGER_KEY_PREFIX = "slack-completion-delivery:";

function markerKey(deliveryId: string, phase: "enqueued" | "posted"): string {
  return `${LEDGER_KEY_PREFIX}${phase}:${deliveryId}`;
}

function logKvFailure(operation: "get" | "put", deliveryId: string, error: unknown): void {
  log.warn("slack.completion.ledger", {
    operation,
    delivery_id: deliveryId,
    outcome: "unavailable",
    error: error instanceof Error ? error : new Error(String(error)),
  });
}

/** A read failure is not a recorded marker. KV has no compare-and-swap. */
async function readMarker(
  env: Env,
  deliveryId: string,
  phase: "enqueued" | "posted"
): Promise<boolean> {
  try {
    const value = await createKvCacheStore(env.SLACK_KV).get(markerKey(deliveryId, phase));
    return value === "1";
  } catch (error) {
    logKvFailure("get", deliveryId, error);
    return false;
  }
}

/** Write-once. Each phase has its own key, so a later enqueue cannot clear a post. */
async function writeMarker(
  env: Env,
  deliveryId: string,
  phase: "enqueued" | "posted"
): Promise<void> {
  try {
    await createKvCacheStore(env.SLACK_KV).put(markerKey(deliveryId, phase), "1", {
      ttlMs: SLACK_COMPLETION_DELIVERY_TTL_MS,
    });
  } catch (error) {
    logKvFailure("put", deliveryId, error);
  }
}

export async function isCompletionEnqueued(env: Env, deliveryId: string): Promise<boolean> {
  return readMarker(env, deliveryId, "enqueued");
}

export async function markCompletionEnqueued(env: Env, deliveryId: string): Promise<void> {
  await writeMarker(env, deliveryId, "enqueued");
}

export async function isCompletionPosted(env: Env, deliveryId: string): Promise<boolean> {
  return readMarker(env, deliveryId, "posted");
}

/** Called when publication starts and the job will not be replayed. */
export async function markCompletionPosted(env: Env, deliveryId: string): Promise<void> {
  await writeMarker(env, deliveryId, "posted");
}
