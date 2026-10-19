import { z } from "zod";

export const SLACK_INGRESS_STATES = [
  "admitted",
  "processing",
  "session_created",
  "prompt_queued",
  "completed",
  "failed",
] as const;
export const SLACK_INGRESS_LATENCY_MILESTONES = [
  "ingress",
  "durable_ingress",
  "ack",
  "activity",
  "session_created",
  "prompt_queued",
  "pi_admitted",
  "terminal",
  "callback",
] as const;
export const slackIngressStateSchema = z.enum(SLACK_INGRESS_STATES);
export const slackIngressAdmitSchema = z
  .strictObject({
    source: z.literal("slack"),
    externalEventId: z.string().min(1).max(255),
    payloadJson: z.string().max(262_144).optional(),
    payloadRef: z.string().min(1).max(512).optional(),
    payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
    actorUserId: z.string().min(1).optional(),
    ownerTeamId: z.string().min(1).optional(),
    channelId: z.string().min(1).max(255),
    threadTs: z.string().min(1).max(64).optional(),
    stableSessionId: z.string().min(1).max(128),
    stableMessageId: z.string().min(1).max(128),
    deadlineAt: z.number().int().positive(),
  })
  .refine(
    (value) => (value.payloadJson === undefined) !== (value.payloadRef === undefined),
    "Exactly one payload source is required"
  );
export const slackIngressClaimSchema = z.strictObject({
  leaseOwner: z.string().min(1).max(128),
  leaseMs: z.number().int().min(1_000).max(300_000),
});
export const slackIngressTransitionSchema = z.strictObject({
  leaseOwner: z.string().min(1).max(128),
  expectedState: slackIngressStateSchema,
  state: slackIngressStateSchema,
  sessionId: z.string().min(1).max(128).optional(),
  errorCode: z.string().min(1).max(128).optional(),
});
export type SlackIngressAdmit = z.infer<typeof slackIngressAdmitSchema>;
