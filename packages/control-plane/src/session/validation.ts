import type { CallbackContext, ClientMessage, SandboxEvent } from "@open-inspect/shared";
import { z } from "zod";

const AttachmentSchema = z.object({
  type: z.enum(["file", "image", "url"]),
  name: z.string(),
  url: z.string().optional(),
  content: z.string().optional(),
  mimeType: z.string().optional(),
});

const ClientCursorSchema = z.object({
  line: z.number(),
  file: z.string(),
});

export const ClientMessageSchema: z.ZodType<ClientMessage> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  z.object({
    type: z.literal("subscribe"),
    token: z.string(),
    clientId: z.string(),
  }),
  z.object({
    type: z.literal("prompt"),
    content: z.string(),
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    attachments: z.array(AttachmentSchema).optional(),
  }),
  z.object({ type: z.literal("stop") }),
  z.object({ type: z.literal("typing") }),
  z.object({
    type: z.literal("presence"),
    status: z.enum(["active", "idle"]),
    cursor: ClientCursorSchema.optional(),
  }),
  z.object({
    type: z.literal("fetch_history"),
    cursor: z.object({
      timestamp: z.number(),
      id: z.string(),
    }),
    limit: z.number().optional(),
  }),
]);

const SandboxEventBaseSchema = {
  sandboxId: z.string(),
  timestamp: z.number(),
};

export const SandboxEventSchema: z.ZodType<SandboxEvent> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("heartbeat"),
    ...SandboxEventBaseSchema,
    status: z.string(),
  }),
  z.object({
    type: z.literal("token"),
    ...SandboxEventBaseSchema,
    content: z.string(),
    messageId: z.string(),
  }),
  z.object({
    type: z.literal("tool_call"),
    ...SandboxEventBaseSchema,
    tool: z.string(),
    args: z.record(z.string(), z.unknown()),
    callId: z.string(),
    status: z.string().optional(),
    output: z.string().optional(),
    messageId: z.string(),
  }),
  z.object({
    type: z.literal("step_start"),
    ...SandboxEventBaseSchema,
    messageId: z.string(),
    isSubtask: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("step_finish"),
    ...SandboxEventBaseSchema,
    messageId: z.string(),
    cost: z.number().optional(),
    tokens: z.number().optional(),
    reason: z.string().optional(),
    isSubtask: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("tool_result"),
    ...SandboxEventBaseSchema,
    callId: z.string(),
    result: z.string(),
    error: z.string().optional(),
    messageId: z.string(),
  }),
  z.object({
    type: z.literal("git_sync"),
    ...SandboxEventBaseSchema,
    status: z.enum(["pending", "in_progress", "completed", "failed"]),
    sha: z.string().optional(),
  }),
  z.object({
    type: z.literal("error"),
    ...SandboxEventBaseSchema,
    error: z.string(),
    messageId: z.string(),
  }),
  z.object({
    type: z.literal("execution_complete"),
    ...SandboxEventBaseSchema,
    messageId: z.string(),
    success: z.boolean(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal("artifact"),
    ...SandboxEventBaseSchema,
    artifactType: z.string(),
    url: z.string(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal("push_complete"),
    branchName: z.string(),
    sandboxId: z.string().optional(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("push_error"),
    branchName: z.string(),
    error: z.string(),
    sandboxId: z.string().optional(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("user_message"),
    content: z.string(),
    messageId: z.string(),
    timestamp: z.number(),
    author: z
      .object({
        participantId: z.string(),
        name: z.string(),
        avatar: z.string().optional(),
      })
      .optional(),
  }),
]);

const SlackCallbackContextSchema = z.object({
  source: z.literal("slack"),
  channel: z.string(),
  threadTs: z.string(),
  repoFullName: z.string(),
  model: z.string(),
  reasoningEffort: z.string().optional(),
  reactionMessageTs: z.string().optional(),
});

const LinearCallbackContextSchema = z.object({
  source: z.literal("linear"),
  issueId: z.string(),
  issueIdentifier: z.string(),
  issueUrl: z.string(),
  repoFullName: z.string(),
  model: z.string(),
  agentSessionId: z.string().optional(),
  organizationId: z.string().optional(),
  emitToolProgressActivities: z.boolean().optional(),
});

export const CallbackContextSchema: z.ZodType<CallbackContext> = z.union([
  SlackCallbackContextSchema,
  LinearCallbackContextSchema,
]);
