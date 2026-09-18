import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import { z } from "zod";
import type { Env } from "../types";

const PENDING_REQUEST_TTL_MS = 60 * 60 * 1000;

/**
 * Locator of the Slack message whose image files are re-fetched at launch.
 * Only the coordinates are persisted — never the file objects themselves — so
 * no URL-bearing Slack payloads sit in KV across the clarification round-trip.
 */
const sourceMessageSchema = z.object({
  ts: z.string().min(1),
  threadTs: z.string().optional(),
});

const threadContextSourceSchema = z.object({
  threadTs: z.string().min(1),
  beforeTs: z.string().min(1),
});

const unattributedPromptSchema = z.object({
  forwardedMessages: z.array(z.string()),
});

const pendingRequestSchema = z.object({
  message: z.string().min(1),
  userId: z.string().min(1),
  /** Present when `message` still needs sender attribution before delivery. */
  unattributedPrompt: unattributedPromptSchema.optional(),
  previousMessages: z.array(z.string()).optional(),
  channelName: z.string().optional(),
  channelDescription: z.string().optional(),
  /** True when the original message had no user text, only images. */
  imageOnly: z.boolean().optional(),
  /** Original trigger ts, used as the eventual follow-up checkpoint. */
  messageTs: z.string().min(1).optional(),
  sourceMessage: sourceMessageSchema.optional(),
  /** Coordinates used to re-fetch prior images without persisting Slack URLs. */
  threadContextSource: threadContextSourceSchema.optional(),
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
    // Parse before persisting so only schema-known fields reach KV.
    JSON.stringify(pendingRequestSchema.parse(request)),
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
