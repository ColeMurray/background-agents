import { z } from "zod";
import { harnessIdSchema } from "../harnesses";
import { sessionListRepositorySchema } from "./repositories";
import {
  sessionEventSchema,
  sessionMessageSchema,
  sessionStatusSchema,
  spawnSourceSchema,
} from "./sessions";
import { stepUsageSchema } from "./usage";

export const TRACE_EXPORT_SCHEMA_VERSION = 2;

const exportPullRequestSchema = z.object({
  repoOwner: z.string(),
  repoName: z.string(),
  prNumber: z.number(),
  url: z.string(),
  lifecycleState: z.enum(["open", "closed", "merged"]),
  isDraft: z.boolean(),
  headBranch: z.string(),
  baseBranch: z.string(),
  headSha: z.string().nullable(),
  providerCreatedAt: z.number().nullable(),
  mergedAt: z.number().nullable(),
  closedAt: z.number().nullable(),
});

const lineBase = { schemaVersion: z.literal(TRACE_EXPORT_SCHEMA_VERSION) };

/**
 * What the harness's own durable state contributed to a session line.
 *
 * A session line is never the whole agent's record: the export carries the
 * session index projection and the collections the session runtime read. When
 * the harness keeps durable state that the export cannot carry, the line
 * says so instead of looking complete.
 */
export const traceExportHarnessStateSchema = z.object({
  /** False: the harness's own durable state is not in this export. */
  included: z.literal(false),
  /** What is missing, in the words of the harness that owns it. */
  reason: z.string(),
});
export type TraceExportHarnessState = z.infer<typeof traceExportHarnessStateSchema>;

/**
 * Pi Durable keeps the agent's own record — the native transcript, the task
 * graph, the compaction boundaries and the workspace files — in its own
 * Durable Object. The export reads the session's index projection and the
 * session runtime's own collections, so that record stays behind, and the
 * line says so rather than looking complete.
 */
export const PI_HARNESS_STATE_NOT_EXPORTED = {
  included: false,
  reason:
    "Pi Durable's native transcript, task graph, compaction boundaries and workspace files are not part of this export; the messages and events are the session's projection of them.",
} satisfies TraceExportHarnessState;

export const traceExportSessionSchema = z.object({
  ...lineBase,
  type: z.literal("session"),
  id: z.string(),
  title: z.string().nullable(),
  status: sessionStatusSchema,
  source: spawnSourceSchema,
  spawnSource: spawnSourceSchema,
  parentSessionId: z.string().nullable(),
  rootSessionId: z.string().nullable(),
  spawnDepth: z.number(),
  harness: harnessIdSchema,
  repoOwner: z.string().nullable(),
  repoName: z.string().nullable(),
  baseBranch: z.string().nullable(),
  model: z.string(),
  provider: z.string().nullable(),
  reasoningEffort: z.string().nullable(),
  userId: z.string().nullable(),
  scmLogin: z.string().nullable(),
  automationId: z.string().nullable(),
  automationRunId: z.string().nullable(),
  environmentId: z.string().nullable(),
  messageCount: z.number(),
  prCount: z.number(),
  totalCost: z.number(),
  activeDurationMs: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  repositories: z.array(sessionListRepositorySchema),
  pullRequests: z.array(exportPullRequestSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** What the harness's own durable state contributed, when it is not all here. */
  harnessState: traceExportHarnessStateSchema.optional(),
  messages: z.array(sessionMessageSchema).optional(),
  events: z.array(sessionEventSchema).optional(),
  usage: z.array(stepUsageSchema).optional(),
});

export const traceExportLineSchema = z.union([
  traceExportSessionSchema,
  z.object({
    ...lineBase,
    type: z.literal("session_error"),
    sessionId: z.string(),
    reason: z.literal("http_error"),
    status: z.number(),
  }),
  z.object({
    ...lineBase,
    type: z.literal("session_error"),
    sessionId: z.string(),
    reason: z.enum(["runtime_failure", "page_cap_reached", "trace_budget_exceeded"]),
  }),
  z.object({ ...lineBase, type: z.literal("cursor"), nextCursor: z.string() }),
  z.object({ ...lineBase, type: z.literal("error") }),
]);

export type TraceExportLine = z.infer<typeof traceExportLineSchema>;
