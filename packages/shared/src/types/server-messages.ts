import { z } from "zod";
import { sessionArtifactSchema } from "./artifacts";
import { sessionRepositoryStateSchema } from "./repositories";
import { sandboxEventSchema } from "./sandbox-events";
import { sandboxStatusSchema, sessionStatusSchema } from "./sessions";
import { clientRequestIdSchema } from "./prompts";

const timelineSequenceSchema = z.number().int().nonnegative().safe();

export const promptQueueItemSchema = z.object({
  messageId: z.string(),
  content: z.string(),
  status: z.enum(["pending", "processing"]),
});
export type PromptQueueItem = z.infer<typeof promptQueueItemSchema>;

const sessionStateSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  repoOwner: z.string().nullable(),
  repoName: z.string().nullable(),
  baseBranch: z.string().nullable(),
  branchName: z.string().nullable(),
  status: sessionStatusSchema,
  sandboxStatus: sandboxStatusSchema,
  messageCount: z.number(),
  createdAt: z.number(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  isProcessing: z.boolean().optional(),
  parentSessionId: z.string().nullable().optional(),
  totalCost: z.number().optional(),
  codeServerUrl: z.string().nullable().optional(),
  codeServerPassword: z.string().nullable().optional(),
  vncUrl: z.string().nullable().optional(),
  vncPassword: z.string().nullable().optional(),
  tunnelUrls: z.record(z.string(), z.string()).nullable().optional(),
  ttydUrl: z.string().nullable().optional(),
  ttydToken: z.string().nullable().optional(),
  sandboxDashboardUrl: z.string().nullable().optional(),
  /**
   * Ordered repository list; [0] = primary. Optional so pre-feature servers
   * and producers stay valid — consumers default to [] (absent means a
   * scalar-era session; synthesize from repoOwner/repoName when rendering).
   */
  repositories: z.array(sessionRepositoryStateSchema).optional(),
  // Environment provenance (design §7.6). environmentName resolves live —
  // null when the environment was deleted after launch.
  environmentId: z.string().nullable().optional(),
  environmentName: z.string().nullable().optional(),
});
export type SessionState = z.infer<typeof sessionStateSchema>;

export const sessionSnapshotStateSchema = sessionStateSchema.omit({
  codeServerPassword: true,
  vncPassword: true,
  ttydToken: true,
});
export type SessionSnapshotState = z.infer<typeof sessionSnapshotStateSchema>;

const participantPresenceSchema = z.object({
  participantId: z.string(),
  userId: z.string(),
  name: z.string(),
  avatar: z.string().optional(),
  status: z.enum(["active", "idle", "away"]),
  lastSeen: z.number(),
});
export type ParticipantPresence = z.infer<typeof participantPresenceSchema>;

const participantSummarySchema = z.object({
  participantId: z.string(),
  userId: z.string().optional(),
  name: z.string(),
  avatar: z.string().optional(),
});

const historyCursorSchema = z.object({
  timestamp: z.number(),
  id: z.string(),
  sequence: z.number().int().nonnegative().optional(),
});

const sessionTimelineEventEnvelopeSchema = z
  .object({
    eventId: z.string().min(1),
    timelineSequence: timelineSequenceSchema,
    event: z.unknown(),
  })
  .strict();

export const sessionTimelineEventSchema = sessionTimelineEventEnvelopeSchema.extend({
  event: sandboxEventSchema,
});
export type SessionTimelineEvent = z.infer<typeof sessionTimelineEventSchema>;

const tolerantSessionTimelineEventsSchema = z
  .array(sessionTimelineEventEnvelopeSchema)
  .transform((items) =>
    items.flatMap((item) => {
      const event = sandboxEventSchema.safeParse(item.event);
      return event.success ? [{ ...item, event: event.data }] : [];
    })
  );

const sessionTimelineSchema = z.object({
  events: tolerantSessionTimelineEventsSchema,
  hasMore: z.boolean(),
  cursor: historyCursorSchema.nullable(),
});

export const sessionSnapshotSchema = z.object({
  session: sessionSnapshotStateSchema,
  artifacts: z.array(sessionArtifactSchema),
  timeline: sessionTimelineSchema,
  spawnError: z.string().nullable().optional(),
  promptQueue: z.array(promptQueueItemSchema),
});
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;

/** Removes sandbox location data before a snapshot crosses a read-only boundary. */
export function redactSessionSnapshotSandboxAccess(snapshot: SessionSnapshot): SessionSnapshot {
  const session = { ...snapshot.session };
  delete session.codeServerUrl;
  delete session.vncUrl;
  delete session.ttydUrl;
  delete session.tunnelUrls;
  delete session.sandboxDashboardUrl;
  return { ...snapshot, session };
}

const serverMessageUnionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pong"), timestamp: z.number() }),
  sessionSnapshotSchema.extend({
    type: z.literal("subscribed"),
    participantId: z.string(),
    participant: participantSummarySchema.optional(),
  }),
  z.object({
    type: z.literal("prompt_queued"),
    clientRequestId: clientRequestIdSchema,
    messageId: z.string(),
    position: z.number().int().positive().nullable(),
  }),
  z.object({
    type: z.literal("prompt_cancelled"),
    clientRequestId: clientRequestIdSchema,
    messageId: z.string(),
  }),
  z.object({
    type: z.literal("prompt_queue_updated"),
    promptQueue: z.array(promptQueueItemSchema),
  }),
  z.object({ type: z.literal("sandbox_event"), event: sandboxEventSchema }),
  z.object({ type: z.literal("presence_sync"), participants: z.array(participantPresenceSchema) }),
  z.object({
    type: z.literal("presence_update"),
    participants: z.array(participantPresenceSchema),
  }),
  z.object({ type: z.literal("presence_leave"), userId: z.string() }),
  z.object({ type: z.literal("sandbox_warming") }),
  z.object({ type: z.literal("sandbox_spawning") }),
  z.object({ type: z.literal("sandbox_status"), status: sandboxStatusSchema }),
  z.object({ type: z.literal("sandbox_ready") }),
  z.object({ type: z.literal("sandbox_error"), error: z.string() }),
  z.object({ type: z.literal("artifact_created"), artifact: sessionArtifactSchema }),
  // Existing artifact changed (e.g. PR lifecycle update). Consumers upsert by
  // artifact id; clients predating this message ignore it and resync on
  // reconnect via `subscribed.artifacts`.
  z.object({ type: z.literal("artifact_updated"), artifact: sessionArtifactSchema }),
  // repoOwner/repoName identify the repository whose branch updated in a
  // multi-repo session (absent means the session's sole repository).
  z.object({
    type: z.literal("session_branch"),
    branchName: z.string(),
    repoOwner: z.string().optional(),
    repoName: z.string().optional(),
  }),
  z.object({ type: z.literal("snapshot_saved"), imageId: z.string(), reason: z.string() }),
  z.object({ type: z.literal("sandbox_restored"), message: z.string() }),
  z.object({ type: z.literal("sandbox_warning"), message: z.string() }),
  z.object({ type: z.literal("processing_status"), isProcessing: z.boolean() }),
  z.object({
    type: z.literal("diff_state_changed"),
    revisionId: z.string().nullable(),
    updatedAt: z.number(),
  }),
  z.object({
    type: z.literal("history_page"),
    items: tolerantSessionTimelineEventsSchema,
    hasMore: z.boolean(),
    cursor: historyCursorSchema.nullable(),
  }),
  z.object({ type: z.literal("session_status"), status: sessionStatusSchema }),
  z.object({ type: z.literal("session_title"), title: z.string() }),
  z.object({
    type: z.literal("child_session_update"),
    childSessionId: z.string(),
    status: sessionStatusSchema,
    title: z.string().nullable(),
  }),
  z.object({ type: z.literal("tunnel_urls"), urls: z.record(z.string(), z.string()) }),
  z.object({ type: z.literal("sandbox_dashboard_url"), url: z.string() }),
  z.object({ type: z.literal("sandbox_access_changed") }),
  z.object({
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
    clientRequestId: clientRequestIdSchema.optional(),
  }),
]);

export const serverMessageSchema = serverMessageUnionSchema;

export type ServerMessage = z.infer<typeof serverMessageSchema>;
