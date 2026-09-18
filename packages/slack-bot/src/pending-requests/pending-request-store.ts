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

const sessionLaunchSnapshotBaseSchema = z.object({
  model: z.string().min(1),
  reasoningEffort: z.string().optional(),
  promptOverrides: resolvedTurnPlanSchema.shape.promptOverrides.optional(),
  branch: z.string().optional(),
  content: z.string().min(1),
  callbackContext: slackCallbackContextSchema,
});

const sessionLaunchSnapshotSchema = sessionLaunchSnapshotBaseSchema.extend({
  attachmentReferences: sessionAttachmentReferencesSchema.optional(),
  attachmentDrops: z
    .array(z.enum(["download_failed", "too_large", "over_cap", "upload_rejected"]))
    .optional(),
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
export type PendingLaunchState = z.infer<typeof pendingLaunchStateSchema>;
export type SessionLaunchSnapshot = z.infer<typeof sessionLaunchSnapshotSchema>;

type PendingRequestLocator = { requestId: string } | { channel: string; threadTs: string };

interface PendingLaunchStateRow {
  selected_value: string;
  session_id: string | null;
  snapshot_json: string | null;
  attachment_references_json: string | null;
  attachment_drops_json: string | null;
}

function pendingRequestKey(requestId: string): string {
  return `pending:${requestId}`;
}

function legacyPendingRequestKey(channel: string, threadTs: string): string {
  return `pending:${channel}:${threadTs}`;
}

function resolvePendingRequestLocator(locator: PendingRequestLocator): string {
  return "requestId" in locator
    ? pendingRequestKey(locator.requestId)
    : legacyPendingRequestKey(locator.channel, locator.threadTs);
}

function parseLaunchStateRow(row: PendingLaunchStateRow | null): PendingLaunchState | undefined {
  if (!row) return undefined;
  const snapshot = row.snapshot_json
    ? sessionLaunchSnapshotBaseSchema.parse(JSON.parse(row.snapshot_json))
    : undefined;
  const attachmentReferences = row.attachment_references_json
    ? sessionAttachmentReferencesSchema.parse(JSON.parse(row.attachment_references_json))
    : undefined;
  const attachmentDrops = row.attachment_drops_json
    ? sessionLaunchSnapshotSchema.shape.attachmentDrops
        .unwrap()
        .parse(JSON.parse(row.attachment_drops_json))
    : undefined;
  return pendingLaunchStateSchema.parse({
    selectedValue: row.selected_value,
    sessionId: row.session_id ?? undefined,
    snapshot: snapshot ? { ...snapshot, attachmentReferences, attachmentDrops } : undefined,
  });
}

function serializeLaunchState(state: PendingLaunchState): {
  snapshotJson: string | null;
  attachmentReferencesJson: string | null;
  attachmentDropsJson: string | null;
} {
  if (!state.snapshot) {
    return { snapshotJson: null, attachmentReferencesJson: null, attachmentDropsJson: null };
  }
  const { attachmentReferences, attachmentDrops, ...snapshot } = state.snapshot;
  return {
    snapshotJson: JSON.stringify(snapshot),
    attachmentReferencesJson: attachmentReferences ? JSON.stringify(attachmentReferences) : null,
    attachmentDropsJson: attachmentDrops ? JSON.stringify(attachmentDrops) : null,
  };
}

async function getStoredLaunchState(
  env: Env,
  locatorKey: string
): Promise<PendingLaunchState | undefined> {
  const row = await env.DB.prepare(
    `SELECT selected_value, session_id, snapshot_json, attachment_references_json,
            attachment_drops_json
     FROM slack_pending_launch_states
     WHERE locator_key = ? AND expires_at > ?`
  )
    .bind(locatorKey, Date.now())
    .first<PendingLaunchStateRow>();
  return parseLaunchStateRow(row);
}

async function transitionPendingRequestLaunchState(
  env: Env,
  locatorKey: string,
  launchState: PendingLaunchState,
  expectedSessionId?: string,
  seedState: PendingLaunchState = launchState
): Promise<PendingLaunchState> {
  const seed = serializeLaunchState(seedState);
  const incoming = serializeLaunchState(launchState);
  const now = Date.now();
  const expiresAt = now + PENDING_REQUEST_TTL_MS;
  const expected = expectedSessionId ?? null;
  const hasAttachmentReferences = incoming.attachmentReferencesJson !== null;
  const clearAttachmentReferences =
    expectedSessionId !== undefined &&
    launchState.sessionId !== undefined &&
    !hasAttachmentReferences;

  const results = await env.DB.batch<PendingLaunchStateRow>([
    env.DB.prepare("DELETE FROM slack_pending_launch_states WHERE expires_at <= ?").bind(now),
    env.DB.prepare(
      `INSERT INTO slack_pending_launch_states (
         locator_key, selected_value, session_id, snapshot_json,
         attachment_references_json, attachment_drops_json, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (locator_key) DO NOTHING`
    ).bind(
      locatorKey,
      seedState.selectedValue,
      seedState.sessionId ?? null,
      seed.snapshotJson,
      seed.attachmentReferencesJson,
      seed.attachmentDropsJson,
      expiresAt
    ),
    env.DB.prepare(
      `UPDATE slack_pending_launch_states
       SET session_id = COALESCE(?, session_id),
           snapshot_json = COALESCE(snapshot_json, ?),
           attachment_references_json = CASE
             WHEN ? = 1 THEN NULL
             WHEN ? = 1 AND session_id = ?
               THEN COALESCE(attachment_references_json, ?)
             ELSE attachment_references_json
           END,
           attachment_drops_json = CASE
             WHEN ? = 1 THEN NULL
             WHEN ? = 1 AND session_id = ?
               THEN COALESCE(attachment_drops_json, ?)
             ELSE attachment_drops_json
           END,
           expires_at = ?
       WHERE locator_key = ? AND selected_value = ?
         AND ((session_id IS NULL AND ? IS NULL) OR session_id = ?)`
    ).bind(
      launchState.sessionId ?? null,
      incoming.snapshotJson,
      clearAttachmentReferences ? 1 : 0,
      hasAttachmentReferences ? 1 : 0,
      launchState.sessionId ?? null,
      incoming.attachmentReferencesJson,
      clearAttachmentReferences ? 1 : 0,
      hasAttachmentReferences ? 1 : 0,
      launchState.sessionId ?? null,
      incoming.attachmentDropsJson,
      expiresAt,
      locatorKey,
      launchState.selectedValue,
      expected,
      expected
    ),
    env.DB.prepare(
      `SELECT selected_value, session_id, snapshot_json, attachment_references_json,
              attachment_drops_json
       FROM slack_pending_launch_states
       WHERE locator_key = ?`
    ).bind(locatorKey),
  ]);
  const stored = parseLaunchStateRow(results.at(-1)?.results[0] ?? null);
  if (!stored) throw new Error("Pending request launch state was not persisted");
  return stored;
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
  if (!result.success || result.data.requestId !== requestId) return null;
  const launchState = await getStoredLaunchState(env, resolvePendingRequestLocator({ requestId }));
  return launchState ? { ...result.data, launchState } : result.data;
}

/** Atomically coordinate recoverable launch state while the base request remains in expiring KV. */
export async function updatePendingRequestLaunchState(
  env: Env,
  locator: PendingRequestLocator,
  launchState: PendingLaunchState,
  expectedSessionId?: string
): Promise<PendingRequest | LegacyPendingRequest | null> {
  const locatorKey = resolvePendingRequestLocator(locator);
  const data = await createKvCacheStore(env.SLACK_KV).get(locatorKey, "json");
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

  const stored = await transitionPendingRequestLaunchState(
    env,
    locatorKey,
    launchState,
    expectedSessionId,
    pending.launchState
  );
  return { ...pending, launchState: stored };
}

export function updateClaimedPendingRequestLaunchState(
  env: Env,
  locator: PendingRequestLocator,
  launchState: PendingLaunchState,
  expectedSessionId?: string
): Promise<PendingLaunchState> {
  return transitionPendingRequestLaunchState(
    env,
    resolvePendingRequestLocator(locator),
    launchState,
    expectedSessionId
  );
}

export async function deletePendingRequest(env: Env, requestId: string): Promise<void> {
  await Promise.all([
    createKvCacheStore(env.SLACK_KV).delete(pendingRequestKey(requestId)),
    env.DB.prepare("DELETE FROM slack_pending_launch_states WHERE locator_key = ?")
      .bind(pendingRequestKey(requestId))
      .run(),
  ]);
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
  if (!result.success) return null;
  const launchState = await getStoredLaunchState(
    env,
    resolvePendingRequestLocator({ channel, threadTs })
  );
  return launchState ? { ...result.data, launchState } : result.data;
}

export async function deleteLegacyPendingRequest(
  env: Env,
  channel: string,
  threadTs: string
): Promise<void> {
  const locatorKey = resolvePendingRequestLocator({ channel, threadTs });
  await Promise.all([
    createKvCacheStore(env.SLACK_KV).delete(locatorKey),
    env.DB.prepare("DELETE FROM slack_pending_launch_states WHERE locator_key = ?")
      .bind(locatorKey)
      .run(),
  ]);
}
