import { z } from "zod";

/**
 * Cross-session messaging.
 *
 * One Pi session may hand a bounded message to another session. The message
 * never carries a credential, and the sender is never presented as the
 * author: the receipt records who initiated it and which session it came
 * from, so the target timeline can say exactly that.
 */

/** The longest message a session may hand to another session. */
export const MAX_CROSS_SESSION_MESSAGE_CHARACTERS = 8_000;
/** The deepest chain of session-to-session messages. */
export const MAX_CROSS_SESSION_DEPTH = 3;
/** How many targets one agent turn may message. */
export const MAX_CROSS_SESSION_FAN_OUT = 5;

export const crossSessionMessageRequestSchema = z
  .object({
    targetSessionId: z.string().min(1).max(256),
    content: z.string().min(1).max(MAX_CROSS_SESSION_MESSAGE_CHARACTERS),
    /** The same request twice must produce one message, never two. */
    idempotencyKey: z.string().min(1).max(512),
    /** The agent conversation that asked for the message. */
    agentConversationId: z.string().min(1).max(256).nullable(),
    /** The task inside that conversation that asked for the message. */
    sourceTaskId: z.string().min(1).max(256).nullable(),
  })
  .strict();

export type CrossSessionMessageRequest = z.infer<typeof crossSessionMessageRequestSchema>;

/**
 * The durable receipt for one delivered cross-session message.
 *
 * It is written before the target is called and read again afterwards, so a
 * retry never delivers the same message twice and a delivery that was
 * interrupted can always be reconciled.
 */
export const crossSessionReceiptSchema = z
  .object({
    receiptId: z.string().min(1),
    sourceSessionId: z.string().min(1),
    targetSessionId: z.string().min(1),
    /** The human whose authority carried the message. */
    humanActorId: z.string().min(1),
    /** The agent conversation and task that produced it. */
    agentConversationId: z.string().nullable(),
    sourceTaskId: z.string().nullable(),
    /** How many session-to-session hops this message has already made. */
    depth: z.number().int().nonnegative(),
    idempotencyKey: z.string().min(1),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

export type CrossSessionReceipt = z.infer<typeof crossSessionReceiptSchema>;

/** What the source session hands to the target session. */
export const crossSessionDeliverySchema = z
  .object({
    receipt: crossSessionReceiptSchema,
    content: z.string().min(1).max(MAX_CROSS_SESSION_MESSAGE_CHARACTERS),
  })
  .strict();

export type CrossSessionDelivery = z.infer<typeof crossSessionDeliverySchema>;

/** The result of one delivery attempt. */
export const crossSessionDeliveryResultSchema = z
  .object({
    receiptId: z.string().min(1),
    status: z.enum(["delivered", "duplicate", "rejected"]),
    /** The message the target now shows, when it was accepted. */
    messageId: z.string().nullable(),
    reason: z.string().nullable(),
  })
  .strict();

export type CrossSessionDeliveryResult = z.infer<typeof crossSessionDeliveryResultSchema>;
