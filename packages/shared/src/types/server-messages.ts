import { z } from "zod";
import { sessionArtifactSchema } from "./artifacts";
import { sandboxEventSchema, tolerantSandboxEventsSchema } from "./sandbox-events";
import { participantPresenceSchema, sessionStateSchema } from "./sessions";
import { sandboxStatusSchema, sessionStatusSchema } from "./statuses";

const participantSummarySchema = z.object({
  participantId: z.string(),
  name: z.string(),
  avatar: z.string().optional(),
});

const historyCursorSchema = z.object({ timestamp: z.number(), id: z.string() });

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
