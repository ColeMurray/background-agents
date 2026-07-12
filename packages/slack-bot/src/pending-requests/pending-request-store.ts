import { createKvCacheStore } from "@open-inspect/shared";
import type { Env } from "../types";

const PENDING_REQUEST_TTL_SECONDS = 3600;

export interface PendingRequest {
  message: string;
  userId: string;
  previousMessages?: string[];
  channelName?: string;
  channelDescription?: string;
}

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
    { expirationTtl: PENDING_REQUEST_TTL_SECONDS }
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
  return data && typeof data === "object" ? (data as PendingRequest) : null;
}

export async function deletePendingRequest(
  env: Env,
  channel: string,
  threadTs: string
): Promise<void> {
  await createKvCacheStore(env.SLACK_KV).delete(pendingRequestKey(channel, threadTs));
}
