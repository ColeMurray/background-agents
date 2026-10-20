import {
  MAX_CROSS_SESSION_DEPTH,
  MAX_CROSS_SESSION_FAN_OUT,
  crossSessionDeliverySchema,
  crossSessionMessageRequestSchema,
  type CrossSessionDeliveryResult,
} from "@open-inspect/shared";
import type { FeatureCapabilityMode } from "@open-inspect/shared/pi-feature-capabilities";
import type { CrossSessionReceiptStore } from "../../../db/cross-session-receipts";
import type {
  CrossSessionSourceDecision,
  CrossSessionTargetDecision,
} from "../../cross-session-authority";
import type { MessageService } from "../../services/message.service";

/**
 * Cross-session messaging inside the session runtime.
 *
 * The source session asks to hand a message to another session. Nothing is
 * written to the target until the source's authority has been checked against
 * current D1 state, a durable receipt exists, and the target has confirmed
 * the receipt and revalidated the same authority for itself.
 */
export interface CrossSessionBridge {
  /** The live deployment mode for new cross-session messages. */
  liveMode(): FeatureCapabilityMode;
  /** The latched capability of this session. */
  sessionCapability(): FeatureCapabilityMode;
  /** The durable receipt authority. */
  receipts: CrossSessionReceiptStore;
  /** Resolve the current authority of the target session for one actor. */
  authorizeTarget(request: {
    sourceSessionId: string;
    actorId: string;
    targetSessionId: string;
  }): Promise<CrossSessionTargetDecision>;
  /** Resolve whether the actor still holds authority in the source session. */
  authorizeSource(request: {
    sourceSessionId: string;
    actorId: string;
  }): Promise<CrossSessionSourceDecision>;
  /** Deliver one message to another session. */
  deliver(targetSessionId: string, delivery: unknown): Promise<Response>;
  /** The human actor whose turn the current operation belongs to. */
  operationActor(operationId: string): string | null;
  /** Whether the current operation belongs to this session. */
  operationBelongsToSession(operationId: string): boolean;
  /** Record the send on the source session's own timeline. */
  recordSend(input: {
    operationId: string;
    actorId: string;
    targetSessionId: string;
    receiptId: string;
    status: "delivered" | "duplicate" | "rejected";
    reason: string | null;
  }): void;
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
        { status: 409 }
      );
    }
    // The originating turn must belong to this session. A turn of another
    // session, or one that no longer exists, may not speak for it.
    if (!bridge.operationBelongsToSession(operationId)) {
      return Response.json(
        { error: "The originating turn does not belong to this session" },
        { status: 403 }
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
      return Response.json(
        { error: "The originating turn has no workspace actor" },
        { status: 403 }
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
      bridge.recordSend({
        operationId,
        actorId,
        targetSessionId: parsed.data.targetSessionId,
        receiptId: existing.id,
        status: "duplicate",
        reason: null,
      });
      return Response.json({
        receiptId: existing.id,
        status: "duplicate",
        messageId: existing.targetMessageId,
        reason: null,
      } satisfies CrossSessionDeliveryResult);
    }

    // The actor must still hold authority in the source session itself.
    const source = await bridge.authorizeSource({ sourceSessionId, actorId });
    if (source.kind === "denied") {
      return Response.json(
        { error: source.reason, code: "cross_session_source_denied" },
        { status: 403 }
      );
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
    // A message may only travel so far. The depth comes from the message
    // that started this turn, so a chain of agents cannot ping-pong forever.
    const depth = await bridge.receipts.depthForOperation(sourceSessionId, operationId);
    if (depth >= MAX_CROSS_SESSION_DEPTH) {
      return Response.json(
        {
          error: "The cross-session message chain is too deep",
          code: "cross_session_depth_exceeded",
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
        // Another attempt claimed the same key. Its receipt is the truth, and
        // this attempt does not deliver a second copy.
        const raced = await bridge.receipts.findByIdempotencyKey(
          sourceSessionId,
          parsed.data.idempotencyKey
        );
        if (!raced) {
          return Response.json(
            { error: "The cross-session receipt could not be claimed" },
            { status: 409 }
          );
        }
        if (raced.status === "delivered") {
          bridge.recordSend({
            operationId,
            actorId,
            targetSessionId: parsed.data.targetSessionId,
            receiptId: raced.id,
            status: "duplicate",
            reason: null,
          });
          return Response.json({
            receiptId: raced.id,
            status: "duplicate",
            messageId: raced.targetMessageId,
            reason: null,
          } satisfies CrossSessionDeliveryResult);
        }
        return Response.json({
          receiptId: raced.id,
          status: raced.status === "pending" ? "duplicate" : "rejected",
          messageId: raced.targetMessageId,
          reason: raced.rejectionReason,
        } satisfies CrossSessionDeliveryResult);
      }
    }

    const decision = await bridge.authorizeTarget({
      sourceSessionId,
      actorId,
      targetSessionId: parsed.data.targetSessionId,
    });
    if (decision.kind === "not_found") {
      await bridge.receipts.markRejected(receipt.id, "target_not_found", Date.now());
      bridge.recordSend({
        operationId,
        actorId,
        targetSessionId: parsed.data.targetSessionId,
        receiptId: receipt.id,
        status: "rejected",
        reason: "target_not_found",
      });
      return Response.json({ error: "The target session was not found" }, { status: 404 });
    }
    if (decision.kind === "denied") {
      await bridge.receipts.markRejected(receipt.id, decision.reason, Date.now());
      bridge.recordSend({
        operationId,
        actorId,
        targetSessionId: parsed.data.targetSessionId,
        receiptId: receipt.id,
        status: "rejected",
        reason: decision.reason,
      });
      return Response.json(
        { error: decision.reason, code: "cross_session_target_denied" },
        { status: 403 }
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
      bridge.recordSend({
        operationId,
        actorId,
        targetSessionId: parsed.data.targetSessionId,
        receiptId: receipt.id,
        status: "rejected",
        reason,
      });
      return Response.json(
        { error: reason, code: "cross_session_delivery_refused" },
        { status: 409 }
      );
    }
    const messageId = body?.messageId ?? null;
    if (messageId) {
      await bridge.receipts.markDelivered(receipt.id, messageId, Date.now());
    }
    bridge.recordSend({
      operationId,
      actorId,
      targetSessionId: parsed.data.targetSessionId,
      receiptId: receipt.id,
      status: messageId ? "delivered" : "rejected",
      reason: body?.reason ?? null,
    });
    return Response.json({
      receiptId: receipt.id,
      status: messageId ? "delivered" : "rejected",
      messageId,
      reason: body?.reason ?? null,
    } satisfies CrossSessionDeliveryResult);
  }

  /**
   * The early gate for a cross-session message.
   *
   * It answers whether this turn may reach for another session at all, before
   * the target is chosen. The full decision, with the target and the receipt,
   * happens in the outbound path.
   */
  async authorize(request: Request): Promise<Response> {
    const bridge = this.options.crossSession;
    const operationId = request.headers.get("X-Pi-Operation-ID");
    if (!operationId || !bridge.operationBelongsToSession(operationId)) {
      return Response.json(
        {
          allowed: false,
          code: "cross_session_turn_not_in_session",
          reason: "The turn does not belong to this session",
        },
        { status: 403 }
      );
    }
    if (bridge.sessionCapability() !== "enabled" || bridge.liveMode() !== "enabled") {
      return Response.json(
        {
          allowed: false,
          code: "cross_session_messaging_disabled",
          reason: "Cross-session messaging is disabled for this session",
        },
        { status: 403 }
      );
    }
    if (!bridge.operationActor(operationId)) {
      return Response.json(
        {
          allowed: false,
          code: "cross_session_actor_missing",
          reason: "The originating turn has no workspace actor",
        },
        { status: 403 }
      );
    }
    return Response.json({ allowed: true }, { headers: { "Cache-Control": "no-store" } });
  }

  /**
   * The target side: accept one message from another session.
   *
   * The target confirms the receipt, revalidates the sender's authority for
   * itself, and only then enqueues. A receipt the target cannot confirm is
   * refused rather than shown.
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
        { status: 404 }
      );
    }
    // The target's own capability decides whether it accepts agent-originated
    // messages at all.
    if (bridge.sessionCapability() !== "enabled" || bridge.liveMode() !== "enabled") {
      return Response.json(
        {
          error: "This session does not accept cross-session messages",
          reason: "cross_session_messaging_disabled",
        },
        { status: 403 }
      );
    }
    // The receipt is the proof. A delivery whose receipt the target cannot
    // confirm is refused, so the provenance can never be asserted by the
    // sender.
    const stored = await bridge.receipts.findById(receipt.receiptId);
    if (
      !stored ||
      stored.sourceSessionId !== receipt.sourceSessionId ||
      stored.targetSessionId !== receipt.targetSessionId ||
      stored.humanActorId !== receipt.humanActorId ||
      stored.idempotencyKey !== receipt.idempotencyKey
    ) {
      return Response.json(
        {
          error: "The cross-session receipt could not be confirmed",
          reason: "receipt_unconfirmed",
        },
        { status: 409 }
      );
    }
    // The target revalidates the sender's authority for itself.
    const decision = await bridge.authorizeTarget({
      sourceSessionId: receipt.sourceSessionId,
      actorId: receipt.humanActorId,
      targetSessionId: sessionId,
    });
    if (decision.kind === "not_found") {
      return Response.json(
        { error: "The target session was not found", reason: "target_not_found" },
        { status: 404 }
      );
    }
    if (decision.kind === "denied") {
      return Response.json({ error: decision.reason, reason: decision.reason }, { status: 403 });
    }

    let enqueued;
    try {
      enqueued = await this.options.messages.enqueuePrompt({
        content,
        // The message belongs to the agent, not to the human. The initiator
        // is named in the provenance instead of being made a participant of
        // this session: a collaborator list, a presence list, and the access
        // rules of the target session must not change because a message
        // arrived.
        authorId: crossSessionAuthorId(receipt.sourceSessionId),
        source: "agent",
        // The receipt id is the request id, so a redelivery is answered by
        // the target's own prompt idempotency instead of a second message.
        clientRequestId: `cross-session:${receipt.receiptId}`,
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
    } catch (error) {
      return Response.json(
        {
          error: "The target session could not accept the message",
          reason: enqueueFailureReason(error),
        },
        { status: 409 }
      );
    }
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

/** Why the target could not accept the message, in bounded terms. */
function enqueueFailureReason(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  switch (name) {
    case "BudgetExhaustedError":
      return "target_budget_exhausted";
    case "PromptQueueFullError":
      return "target_queue_full";
    case "SessionNotPromptableError":
      return "target_not_promptable";
    case "SandboxPromptBlockedError":
      return "target_sandbox_blocked";
    default:
      return "target_refused";
  }
}

/** The content hash that proves a reused request key carries the same message. */
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
