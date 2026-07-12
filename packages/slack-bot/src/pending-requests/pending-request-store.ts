import { createKvCacheStore } from "@open-inspect/shared";
import { z } from "zod";
import type { Env } from "../types";

const PENDING_REQUEST_TTL_MS = 60 * 60 * 1000;

const pendingRequestSchema = z.object({
  message: z.string().min(1),
  userId: z.string().min(1),
  previousMessages: z.array(z.string()).optional(),
  channelName: z.string().optional(),
  channelDescription: z.string().optional(),
});

export type PendingRequest = z.infer<typeof pendingRequestSchema>;

function pendingRequestKey(channel: string, threadTs: string): string {
  return `pending:${channel}:${threadTs}`;
}

export async function storePendingRequest(
  env: Env,
  channel: string,
  threadTs: string,
  request: PendingRequest
): Promise<void> {
  await createKvCacheStore(env.SLACK_KV).put(
    pendingRequestKey(channel, threadTs),
    JSON.stringify(request),
    { expirationTtl: PENDING_REQUEST_TTL_MS / 1000 }
  );
}

export async function getPendingRequest(
  env: Env,
  channel: string,
  threadTs: string
): Promise<PendingRequest | null> {
  const data = await createKvCacheStore(env.SLACK_KV).get(
    pendingRequestKey(channel, threadTs),
    "json"
  );
  const result = pendingRequestSchema.safeParse(data);
  return result.success ? result.data : null;
}

export async function deletePendingRequest(
  env: Env,
  channel: string,
  threadTs: string
): Promise<void> {
  await createKvCacheStore(env.SLACK_KV).delete(pendingRequestKey(channel, threadTs));
}
