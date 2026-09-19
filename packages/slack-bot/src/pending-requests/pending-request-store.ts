import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import { z } from "zod";
import { resolvedTurnPlanSchema, sessionLaunchPlanSchema } from "../inline-flags";
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

const inlinePromptOptionsSchema = z.object({
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
});

const classificationSchema = z.object({
  targetId: z.string().min(1).optional(),
  confidence: z.enum(["high", "medium", "low"]),
  source: z.enum(["routing_rule", "channel_association", "llm"]),
});

const pendingRequestDataSchema = z.object({
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
  /** Model settings the deferred launch should use, revalidated at launch. */
  launchPlan: sessionLaunchPlanSchema.optional(),
  /** Superseded by `launchPlan`; still read so in-flight records survive a deploy. */
  turnPlan: resolvedTurnPlanSchema.optional(),
  /** Classifier provenance retained until the user resolves clarification. */
  classification: classificationSchema.optional(),
});

const pendingRequestSchema = pendingRequestDataSchema.extend({
  requestId: z.string().uuid(),
  channel: z.string().min(1),
  threadTs: z.string().min(1),
});

const legacyPendingRequestSchema = pendingRequestDataSchema.extend({
  inlinePromptOptions: inlinePromptOptionsSchema.optional(),
});

export type PendingRequest = z.infer<typeof pendingRequestSchema>;
export type LegacyPendingRequest = z.infer<typeof legacyPendingRequestSchema>;

function pendingRequestKey(requestId: string): string {
  return `pending:${requestId}`;
}

function legacyPendingRequestKey(channel: string, threadTs: string): string {
  return `pending:${channel}:${threadTs}`;
}

export async function storePendingRequest(env: Env, request: PendingRequest): Promise<void> {
  await createKvCacheStore(env.SLACK_KV).put(
    pendingRequestKey(request.requestId),
    // Parse before persisting so only schema-known fields reach KV.
    JSON.stringify(pendingRequestSchema.parse(request)),
    { expirationTtl: PENDING_REQUEST_TTL_MS / 1000 }
  );
}

export async function getPendingRequest(
  env: Env,
  requestId: string
): Promise<PendingRequest | null> {
  const data = await createKvCacheStore(env.SLACK_KV).get(pendingRequestKey(requestId), "json");
  const result = pendingRequestSchema.safeParse(data);
  return result.success && result.data.requestId === requestId ? result.data : null;
}

export async function deletePendingRequest(env: Env, requestId: string): Promise<void> {
  await createKvCacheStore(env.SLACK_KV).delete(pendingRequestKey(requestId));
}

export async function getLegacyPendingRequest(
  env: Env,
  channel: string,
  threadTs: string
): Promise<LegacyPendingRequest | null> {
  const data = await createKvCacheStore(env.SLACK_KV).get(
    legacyPendingRequestKey(channel, threadTs),
    "json"
  );
  const result = legacyPendingRequestSchema.safeParse(data);
  return result.success ? result.data : null;
}

export async function deleteLegacyPendingRequest(
  env: Env,
  channel: string,
  threadTs: string
): Promise<void> {
  await createKvCacheStore(env.SLACK_KV).delete(legacyPendingRequestKey(channel, threadTs));
}
