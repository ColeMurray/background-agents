import { z } from "zod";
import { sessionArtifactSchema } from "./artifacts";
import { sessionRepositoryStateSchema } from "./repositories";
import { sandboxEventSchema } from "./sandbox-events";
import { sandboxStatusSchema, sessionStatusSchema } from "./sessions";

/**
 * Sandbox event arrays for session hydration — both the initial `subscribed`
 * replay and paginated `history_page` items, which read from the same event
 * store. Resilient to unknown/legacy event shapes: each event is validated
 * individually and dropped if it doesn't match, instead of failing the whole
 * message. A single unrecognized event must never wedge session hydration and
 * strand the client on "loading session" forever.
 */
const tolerantSandboxEventsSchema = z.array(z.unknown()).transform((events) =>
  events.flatMap((event) => {
    const result = sandboxEventSchema.safeParse(event);
    return result.success ? [result.data] : [];
  })
);

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

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pong"), timestamp: z.number() }),
  z.object({
    type: z.literal("subscribed"),
    sessionId: z.string(),
    state: sessionStateSchema,
    artifacts: z.array(sessionArtifactSchema),
    participantId: z.string(),
    participant: participantSummarySchema.optional(),
    replay: z
      .object({
        events: tolerantSandboxEventsSchema,
        hasMore: z.boolean(),
        cursor: historyCursorSchema.nullable(),
      })
      .optional(),
    spawnError: z.string().nullable().optional(),
  }),
  z.object({ type: z.literal("prompt_queued"), messageId: z.string(), position: z.number() }),
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
    items: tolerantSandboxEventsSchema,
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
  z.object({ type: z.literal("code_server_info"), url: z.string(), password: z.string() }),
  z.object({ type: z.literal("ttyd_info"), url: z.string(), token: z.string() }),
  z.object({ type: z.literal("tunnel_urls"), urls: z.record(z.string(), z.string()) }),
  z.object({ type: z.literal("sandbox_dashboard_url"), url: z.string() }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
