import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import { sessionAttachmentReferencesSchema } from "@open-inspect/shared/types/session-attachments";
import { slackCallbackContextSchema } from "@open-inspect/shared/types/session-api";
import { z } from "zod";
import { resolvedTurnPlanSchema } from "../inline-flags";
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

const sessionLaunchSnapshotSchema = z.object({
  model: z.string().min(1),
  reasoningEffort: z.string().optional(),
  promptOverrides: resolvedTurnPlanSchema.shape.promptOverrides.optional(),
  branch: z.string().optional(),
  content: z.string().min(1),
  callbackContext: slackCallbackContextSchema,
  attachmentReferences: sessionAttachmentReferencesSchema.optional(),
});

const pendingLaunchStateSchema = z.object({
  selectedValue: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  snapshot: sessionLaunchSnapshotSchema.optional(),
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
  turnPlan: resolvedTurnPlanSchema.optional(),
  /** Classifier provenance retained until the user resolves clarification. */
  classification: classificationSchema.optional(),
  /** Recoverable state for retrying delivery after session creation. */
  launchState: pendingLaunchStateSchema.optional(),
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
type PendingLaunchState = z.infer<typeof pendingLaunchStateSchema>;
export type SessionLaunchSnapshot = z.infer<typeof sessionLaunchSnapshotSchema>;

type PendingRequestLocator = { requestId: string } | { channel: string; threadTs: string };

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

/** Reload and persist recoverable launch state without retaining unknown fields. */
export async function updatePendingRequestLaunchState(
  env: Env,
  locator: PendingRequestLocator,
  launchState: PendingLaunchState,
  expectedSessionId?: string
): Promise<PendingRequest | LegacyPendingRequest | null> {
  const store = createKvCacheStore(env.SLACK_KV);
  const key =
    "requestId" in locator
      ? pendingRequestKey(locator.requestId)
      : legacyPendingRequestKey(locator.channel, locator.threadTs);
  const data = await store.get(key, "json");
  let pending: PendingRequest | LegacyPendingRequest;
  if ("requestId" in locator) {
    const parsed = pendingRequestSchema.safeParse(data);
    if (!parsed.success || parsed.data.requestId !== locator.requestId) return null;
    pending = parsed.data;
  } else {
    const parsed = pendingRequestDataSchema.safeParse(data);
    if (!parsed.success) return null;
    pending = parsed.data;
  }

  const current = pending.launchState;
  const canReplace =
    current?.selectedValue === launchState.selectedValue && current.sessionId === expectedSessionId;
  const updated = !current || canReplace ? { ...pending, launchState } : pending;
  await store.put(key, JSON.stringify(updated), { expirationTtl: PENDING_REQUEST_TTL_MS / 1000 });
  return updated;
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
