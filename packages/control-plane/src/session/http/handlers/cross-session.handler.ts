import { z } from "zod";
import {
  MAX_CROSS_SESSION_DEPTH,
  MAX_CROSS_SESSION_FAN_OUT,
  crossSessionDeliverySchema,
  crossSessionMessageRequestSchema,
  type CrossSessionDeliveryResult,
} from "@open-inspect/shared";
import type { FeatureCapabilityMode } from "@open-inspect/shared/pi-feature-capabilities";
import type { CrossSessionReceiptStore } from "../../../db/cross-session-receipts";
import type { CrossSessionTargetDecision } from "../../cross-session-authority";
import type { MessageService } from "../../services/message.service";

/**
 * Cross-session messaging inside the session runtime.
 *
 * The source session asks to hand a message to another session. Nothing is
 * written to the target until the source's authority has been checked against
 * current D1 state, a durable receipt exists, and the target has revalidated
 * the same authority for itself.
 */
export interface CrossSessionBridge {
  /** The live deployment mode for new cross-session messages. */
  liveMode(): FeatureCapabilityMode;
  /** The latched capability of this session. */
  sessionCapability(): FeatureCapabilityMode;
  /** The durable receipt authority. */
  receipts: CrossSessionReceiptStore;
  /** Resolve the current authority of the target session for one actor. */
  authorizeTarget(actorId: string, targetSessionId: string): Promise<CrossSessionTargetDecision>;
  /** Deliver one message to another session. */
  deliver(targetSessionId: string, delivery: unknown): Promise<Response>;
  /** The human actor whose turn the current operation belongs to. */
  operationActor(operationId: string): string | null;
  /** How many session-to-session hops the current operation's message has made. */
  operationDepth(operationId: string): number;
}

export interface CrossSessionHandlerOptions {
  crossSession: CrossSessionBridge;
  messages: MessageService;
  getSessionId: () => string;
}

export class CrossSessionHandler {
  constructor(private readonly options: CrossSessionHandlerOptions) {}

  /**
   * The source side: hand one bounded message to another session.
   */
  async outbound(request: Request): Promise<Response> {
    const bridge = this.options.crossSession;
    const parsed = crossSessionMessageRequestSchema.safeParse(
      await request.json().catch(() => null)
    );
    if (!parsed.success) {
      return Response.json({ error: "Invalid cross-session message" }, { status: 400 });
    }
    const operationId = request.headers.get("X-Pi-Operation-ID");
    if (!operationId) {
      return Response.json(
        { error: "Cross-session messaging requires an active operation" },
        {
          status: 409,
        }
      );
    }
    // The session's own capability and the live deployment mode both have to
    // allow it. A deployment deny never strands an admitted message, because
    // the receipt is written only once both gates have passed.
    if (bridge.sessionCapability() !== "enabled" || bridge.liveMode() !== "enabled") {
      return Response.json(
        {
          error: "Cross-session messaging is disabled for this session",
          code: "cross_session_messaging_disabled",
        },
        { status: 403 }
      );
    }

    const actorId = bridge.operationActor(operationId);
    if (!actorId) {
      return Response.json({ error: "The originating turn has no human actor" }, { status: 403 });
    }
    // A message may only travel so far. The depth comes from the message that
    // started this turn, so a chain of agents cannot ping-pong forever.
    const depth = bridge.operationDepth(operationId);
    if (depth >= MAX_CROSS_SESSION_DEPTH) {
      return Response.json(
        {
          error: "The cross-session message chain is too deep",
          code: "cross_session_depth_exceeded",
        },
        { status: 409 }
      );
    }

    const sourceSessionId = this.options.getSessionId();
    const contentHash = await sha256Hex(parsed.data.content);
    const existing = await bridge.receipts.findByIdempotencyKey(
      sourceSessionId,
      parsed.data.idempotencyKey
    );
    if (existing && existing.contentSha256 !== contentHash) {
      return Response.json(
        { error: "The request key was reused with different content" },
        { status: 409 }
      );
    }
    if (existing?.status === "delivered") {
      return Response.json({
        receiptId: existing.id,
        status: "duplicate",
        messageId: existing.targetMessageId,
        reason: null,
      } satisfies CrossSessionDeliveryResult);
    }
    // One turn may reach only so many other sessions. The count is what this
    // turn already produced, so a retry of the same request does not consume
    // another slot.
    const produced = await bridge.receipts.countForOperation(sourceSessionId, operationId);
    if (produced >= MAX_CROSS_SESSION_FAN_OUT) {
      return Response.json(
        {
          error: "This turn already reached the maximum number of other sessions",
          code: "cross_session_fan_out_exceeded",
        },
        { status: 409 }
      );
    }

    const receipt = existing ?? {
      id: `xsr_${crypto.randomUUID()}`,
      sourceSessionId,
      targetSessionId: parsed.data.targetSessionId,
      operationId,
      humanActorId: actorId,
      agentConversationId: parsed.data.agentConversationId,
      sourceTaskId: parsed.data.sourceTaskId,
      depth,
      idempotencyKey: parsed.data.idempotencyKey,
      contentSha256: contentHash,
      status: "pending" as const,
      targetMessageId: null,
      rejectionReason: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (!existing) {
      const created = await bridge.receipts.create(receipt);
      if (!created) {
        // Another attempt claimed the same key. Answer from that attempt.
        const raced = await bridge.receipts.findByIdempotencyKey(
          sourceSessionId,
          parsed.data.idempotencyKey
        );
        if (raced?.status === "delivered") {
          return Response.json({
            receiptId: raced.id,
            status: "duplicate",
            messageId: raced.targetMessageId,
            reason: null,
          } satisfies CrossSessionDeliveryResult);
        }
        if (!raced) {
          return Response.json(
            { error: "The cross-session receipt could not be claimed" },
            {
              status: 409,
            }
          );
        }
        receipt.id = raced.id;
        receipt.status = raced.status;
      }
    }

    const decision = await bridge.authorizeTarget(actorId, parsed.data.targetSessionId);
    if (decision.kind === "not_found") {
      await bridge.receipts.markRejected(receipt.id, "target_not_found", Date.now());
      return Response.json({ error: "The target session was not found" }, { status: 404 });
    }
    if (decision.kind === "denied") {
      await bridge.receipts.markRejected(receipt.id, decision.reason, Date.now());
      return Response.json(
        { error: decision.reason, code: "cross_session_target_denied" },
        {
          status: 403,
        }
      );
    }

    const delivery = await bridge.deliver(parsed.data.targetSessionId, {
      receipt: {
        receiptId: receipt.id,
        sourceSessionId: receipt.sourceSessionId,
        targetSessionId: receipt.targetSessionId,
        humanActorId: receipt.humanActorId,
        agentConversationId: receipt.agentConversationId,
        sourceTaskId: receipt.sourceTaskId,
        depth: receipt.depth,
        idempotencyKey: receipt.idempotencyKey,
        createdAt: receipt.createdAt,
      },
      content: parsed.data.content,
    });
    const body = (await delivery.json().catch(() => null)) as {
      messageId?: string | null;
      reason?: string | null;
    } | null;
    if (!delivery.ok) {
      const reason = body?.reason ?? "The target session refused the message";
      await bridge.receipts.markRejected(receipt.id, reason, Date.now());
      return Response.json(
        { error: reason, code: "cross_session_delivery_refused" },
        {
          status: 409,
        }
      );
    }
    const messageId = body?.messageId ?? null;
    if (messageId) {
      await bridge.receipts.markDelivered(receipt.id, messageId, Date.now());
    }
    return Response.json({
      receiptId: receipt.id,
      status: messageId ? "delivered" : "rejected",
      messageId,
      reason: body?.reason ?? null,
    } satisfies CrossSessionDeliveryResult);
  }

  /**
   * The target side: accept one message from another session.
   *
   * The target revalidates the sender's authority for itself. A receipt that
   * the target cannot confirm is refused rather than shown.
   */
  async inbound(request: Request): Promise<Response> {
    const bridge = this.options.crossSession;
    const parsed = crossSessionDeliverySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "Invalid cross-session delivery" }, { status: 400 });
    }
    const { receipt, content } = parsed.data;
    const sessionId = this.options.getSessionId();
    if (receipt.targetSessionId !== sessionId) {
      return Response.json(
        { error: "The target session does not match this delivery" },
        {
          status: 404,
        }
      );
    }
    const decision = await bridge.authorizeTarget(receipt.humanActorId, sessionId);
    if (decision.kind === "not_found") {
      return Response.json({ error: "The target session was not found" }, { status: 404 });
    }
    if (decision.kind === "denied") {
      return Response.json({ error: decision.reason, reason: decision.reason }, { status: 403 });
    }

    const enqueued = await this.options.messages.enqueuePrompt({
      content,
      // The message belongs to the agent, not to the human. The initiator is
      // named in the provenance instead of being made a participant of this
      // session: a collaborator list, a presence list, and the access rules of
      // the target session must not change because a message arrived.
      authorId: crossSessionAuthorId(receipt.sourceSessionId),
      source: "agent",
      scmEnrichment: {
        userId: null,
        login: null,
        name: `Agent (session ${receipt.sourceSessionId})`,
        email: null,
      },
      originContext: {
        kind: "cross_session",
        receiptId: receipt.receiptId,
        sourceSessionId: receipt.sourceSessionId,
        humanActorId: receipt.humanActorId,
        agentConversationId: receipt.agentConversationId,
        sourceTaskId: receipt.sourceTaskId,
        // The stored message has travelled one hop further than the receipt.
        depth: receipt.depth + 1,
      },
    });
    return Response.json(
      {
        receiptId: receipt.receiptId,
        status: "delivered",
        messageId: enqueued.messageId,
        reason: null,
      } satisfies CrossSessionDeliveryResult,
      { status: 200 }
    );
  }
}

/** The content hash that proves a reused request key carries the same message. */
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The identity a message from another session is authored by.
 *
 * It is a machine identity, never the human who initiated the message: making
 * that human a participant of the target session would change the target's
 * participant list for a message that arrived from somewhere else.
 */
export function crossSessionAuthorId(sourceSessionId: string): string {
  return `cross-session:${sourceSessionId}`;
}

export const crossSessionDeliveryEnvelopeSchema = z.unknown();
