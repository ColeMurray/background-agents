/**
 * Per-thread record of whether a channel thread is a solo thread: a thread
 * where one person and bots are the only posters, so that person's untagged
 * replies may continue the thread's session (see `../solo-threads.ts`).
 *
 * It lives under its own key rather than inside the thread→session record,
 * which is rewritten read-modify-write on every prompt and would race with a
 * block.
 */

import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import { z } from "zod";
import type { Env } from "../types";
import { THREAD_SESSION_TTL_MS } from "./thread-session-store";

/** A solo-thread record lasts as long as the thread's session mapping. */
const SOLO_THREAD_TTL_MS = THREAD_SESSION_TTL_MS;

const soloThreadRecordSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("owned"), ownerUserId: z.string().min(1) }),
  z.object({ kind: z.literal("blocked") }),
]);

/**
 * `owned`: only `ownerUserId` has posted, and the acknowledgement told them so.
 * `blocked`: another person posted, and instructions need a mention for good.
 */
export type SoloThreadRecord = z.infer<typeof soloThreadRecordSchema>;

function getSoloThreadKey(channel: string, threadTs: string): string {
  return `solo-thread:${channel}:${threadTs}`;
}

/**
 * Read a thread's solo record, or null when it has none. KV errors propagate:
 * a caller that cannot read a block must not act as if there were none.
 */
export async function lookupSoloThread(
  env: Env,
  channel: string,
  threadTs: string
): Promise<SoloThreadRecord | null> {
  const data = await createKvCacheStore(env.SLACK_KV).get(
    getSoloThreadKey(channel, threadTs),
    "json"
  );
  const result = soloThreadRecordSchema.safeParse(data);
  return result.success ? result.data : null;
}

/** Write a thread's solo record. KV errors propagate, so the caller knows it was not kept. */
export async function storeSoloThread(
  env: Env,
  channel: string,
  threadTs: string,
  record: SoloThreadRecord
): Promise<void> {
  await createKvCacheStore(env.SLACK_KV).put(
    getSoloThreadKey(channel, threadTs),
    JSON.stringify(record),
    { ttlMs: SOLO_THREAD_TTL_MS }
  );
}
