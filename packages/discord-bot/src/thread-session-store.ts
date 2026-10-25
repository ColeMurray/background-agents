import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import { z } from "zod";
import type { Env } from "./types";

/** Thread mappings outlive Discord's longest auto-archive window. */
const THREAD_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The session a task thread belongs to, so `/task` inside it sends a follow-up. */
const threadSessionSchema = z.object({
  sessionId: z.string().min(1),
  repoFullName: z.string().min(1),
  model: z.string().min(1),
  createdAt: z.number().finite().nonnegative(),
});

export type ThreadSession = z.infer<typeof threadSessionSchema>;

function threadKey(threadId: string): string {
  return `thread:${threadId}`;
}

/** A read outage must fail the task, not create a second session in this thread. */
export async function lookupThreadSession(
  env: Env,
  threadId: string
): Promise<ThreadSession | null> {
  const raw = await createKvCacheStore(env.DISCORD_KV).get(threadKey(threadId), "json");
  const parsed = threadSessionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The caller logs write failures and continues with the already-created thread. */
export async function storeThreadSession(
  env: Env,
  threadId: string,
  session: ThreadSession
): Promise<void> {
  await createKvCacheStore(env.DISCORD_KV).put(threadKey(threadId), JSON.stringify(session), {
    ttlMs: THREAD_SESSION_TTL_MS,
  });
}
