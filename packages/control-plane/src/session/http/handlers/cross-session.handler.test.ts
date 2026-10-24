import { describe, expect, it, vi } from "vitest";
import { CrossSessionHandler, type CrossSessionBridge } from "./cross-session.handler";
import type { CrossSessionTargetDecision } from "../../cross-session-authority";

function harness(
  options: {
    sessionCapability?: "off" | "read_only" | "enabled";
    liveMode?: "off" | "read_only" | "enabled";
    actorId?: string | null;
    decision?: CrossSessionTargetDecision;
    delivered?: boolean;
    depth?: number;
    fanOut?: number;
    sourceDecision?: { kind: "allowed" } | { kind: "denied"; reason: string };
  } = {}
) {
  const receipts = new Map<
    string,
    {
      id: string;
      sourceSessionId: string;
      targetSessionId: string;
      operationId: string;
      humanActorId: string;
      agentConversationId: string | null;
      sourceTaskId: string | null;
      depth: number;
      idempotencyKey: string;
      contentSha256: string;
      status: "pending" | "delivered" | "rejected";
      targetMessageId: string | null;
      rejectionReason: string | null;
      createdAt: number;
      updatedAt: number;
    }
  >();
  const deliver = vi.fn(async () =>
    options.delivered === false
      ? Response.json({ reason: "the target refused it" }, { status: 403 })
      : Response.json({ messageId: "message-1", reason: null })
  );
  const bridge: CrossSessionBridge = {
    liveMode: () => options.liveMode ?? "enabled",
    sessionCapability: () => options.sessionCapability ?? "enabled",
    receipts: {
      findByIdempotencyKey: async (sourceSessionId: string, idempotencyKey: string) => {
        for (const receipt of receipts.values()) {
          if (
            receipt.sourceSessionId === sourceSessionId &&
            receipt.idempotencyKey === idempotencyKey
          )
            return receipt;
        }
        return null;
      },
      findById: async (id: string) => {
        for (const receipt of receipts.values()) {
          if (receipt.id === id) return receipt;
        }
        return null;
      },
      countForOperation: async (sourceSessionId: string, operationId: string) => {
        if (options.fanOut !== undefined) return options.fanOut;
        let total = 0;
        for (const receipt of receipts.values()) {
          if (receipt.sourceSessionId === sourceSessionId && receipt.operationId === operationId)
            total += 1;
        }
        return total;
      },
      createWithinFanOutLimit: async (
        receipt: typeof receipts extends Map<string, infer V> ? V : never,
        limit: number
      ) => {
        const produced = [...receipts.values()].filter(
          (candidate) =>
            candidate.sourceSessionId === receipt.sourceSessionId &&
            candidate.operationId === receipt.operationId
        ).length;
        if ((options.fanOut ?? produced) >= limit || receipts.has(receipt.idempotencyKey)) {
          return false;
        }
        receipts.set(receipt.idempotencyKey, receipt);
        return true;
      },
      markDelivered: async (id: string, messageId: string) => {
        for (const receipt of receipts.values()) {
          if (receipt.id === id) {
            receipt.status = "delivered";
            receipt.targetMessageId = messageId;
            return true;
          }
        }
        return false;
      },
      markRejected: async (id: string, reason: string) => {
        for (const receipt of receipts.values()) {
          if (receipt.id === id) {
            receipt.status = "rejected";
            receipt.rejectionReason = reason;
            return true;
          }
        }
        return false;
      },
    } as unknown as CrossSessionBridge["receipts"],
    authorizeTarget: async () =>
      options.decision ?? { kind: "allowed", row: {} as never, actorId: "user-1" },
    authorizeSource: async () => options.sourceDecision ?? { kind: "allowed" },
    operationBelongsToSession: () => true,
    operationDepth: () => options.depth ?? null,
    recordSend: vi.fn(),
    deliver,
    operationActor: () => (options.actorId === undefined ? "user-1" : options.actorId),
  };
  const enqueuePrompt = vi.fn(async () => ({ messageId: "message-1", status: "queued" as const }));
  const handler = new CrossSessionHandler({
    crossSession: bridge,
    messages: { enqueuePrompt } as never,
    getSessionId: () => "session-1",
  });
  return {
    handler,
    bridge,
    deliver,
    enqueuePrompt,
    receipts,
    seedReceipt() {
      receipts.set("xsr_1", {
        id: "xsr_1",
        sourceSessionId: "session-1",
        targetSessionId: "session-1",
        operationId: "message-1",
        humanActorId: "user-1",
        agentConversationId: "conversation-1",
        sourceTaskId: "task-1",
        depth: 0,
        idempotencyKey: "pi:message-1:call-1",
        contentSha256: "hash",
        status: "pending",
        targetMessageId: null,
        rejectionReason: null,
        createdAt: 1000,
        updatedAt: 1000,
      });
    },
  };
}

const request = {
  targetSessionId: "session-2",
  content: "The build is green on my branch.",
  idempotencyKey: "pi:message-1:call-1",
  agentConversationId: "conversation-1",
  sourceTaskId: "task-1",
};

function outboundRequest(body: unknown = request, operationId = "message-1") {
  return new Request("http://session/internal/cross-session-message", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Pi-Operation-ID": operationId,
    },
    body: JSON.stringify(body),
  });
}

describe("CrossSessionHandler", () => {
  it("answers the early gate when this turn may reach for another session", async () => {
    const h = harness();

    const response = await h.handler.authorize(outboundRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ allowed: true });
    // The early gate never delivers anything.
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("refuses the early gate when the session capability is off", async () => {
    const h = harness({ sessionCapability: "off" });

    const response = await h.handler.authorize(outboundRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      allowed: false,
      code: "cross_session_messaging_disabled",
    });
  });

  it("refuses the early gate when the live deployment mode denies it", async () => {
    const h = harness({ liveMode: "off" });

    const response = await h.handler.authorize(outboundRequest());

    expect(response.status).toBe(403);
  });

  it("refuses the early gate for a turn that does not belong to this session", async () => {
    const h = harness();
    h.bridge.operationBelongsToSession = () => false;

    const response = await h.handler.authorize(outboundRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      allowed: false,
      code: "cross_session_turn_not_in_session",
    });
  });

  it("refuses the early gate for a turn with no workspace actor", async () => {
    const h = harness({ actorId: null });

    const response = await h.handler.authorize(outboundRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      allowed: false,
      code: "cross_session_actor_missing",
    });
  });

  it("delivers a message to a target the actor may collaborate in", async () => {
    const h = harness();

    const response = await h.handler.outbound(outboundRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "delivered",
      messageId: "message-1",
    });
    expect(h.deliver).toHaveBeenCalledWith(
      "session-2",
      expect.objectContaining({ content: request.content })
    );
  });

  it("increments depth from the incoming message provenance", async () => {
    const h = harness({ depth: 1 });

    const response = await h.handler.outbound(outboundRequest());

    expect(response.status).toBe(200);
    expect([...h.receipts.values()][0]?.depth).toBe(2);
  });

  it("refuses a new message when the session capability is off", async () => {
    const h = harness({ sessionCapability: "off" });

    const response = await h.handler.outbound(outboundRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "cross_session_messaging_disabled",
    });
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("refuses a new message when the live deployment mode denies it", async () => {
    const h = harness({ liveMode: "read_only" });

    const response = await h.handler.outbound(outboundRequest());

    expect(response.status).toBe(403);
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("refuses a message with no human actor", async () => {
    const h = harness({ actorId: null });

    const response = await h.handler.outbound(outboundRequest());

    expect(response.status).toBe(403);
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("refuses a target the actor may not collaborate in", async () => {
    const h = harness({ decision: { kind: "denied", reason: "not a member" } });

    const response = await h.handler.outbound(outboundRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "cross_session_target_denied",
    });
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("answers a retry with the same message instead of sending it twice", async () => {
    const h = harness();

    const first = await h.handler.outbound(outboundRequest());
    const second = await h.handler.outbound(outboundRequest());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      status: "duplicate",
      messageId: "message-1",
    });
    expect(h.deliver).toHaveBeenCalledOnce();
  });

  it("refuses a reused request key that carries different content", async () => {
    const h = harness();
    await h.handler.outbound(outboundRequest());

    const response = await h.handler.outbound(
      outboundRequest({ ...request, content: "something else entirely" })
    );

    expect(response.status).toBe(409);
    expect(h.deliver).toHaveBeenCalledOnce();
  });

  it("records a refused delivery on the receipt", async () => {
    const h = harness({ delivered: false });

    const response = await h.handler.outbound(outboundRequest());

    expect(response.status).toBe(409);
    const receipt = [...h.receipts.values()][0];
    expect(receipt?.status).toBe("rejected");
  });

  it("refuses a message whose chain is already too deep", async () => {
    const h = harness({ depth: 3 });

    const response = await h.handler.outbound(outboundRequest());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "cross_session_depth_exceeded",
    });
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("refuses a turn that already reached the maximum number of other sessions", async () => {
    const h = harness({ fanOut: 5 });

    const response = await h.handler.outbound(outboundRequest());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "cross_session_fan_out_exceeded",
    });
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("accepts a delivery in the target and records its provenance", async () => {
    const h = harness();
    h.seedReceipt();
    const delivery = {
      receipt: {
        receiptId: "xsr_1",
        sourceSessionId: "session-1",
        targetSessionId: "session-1",
        humanActorId: "user-1",
        agentConversationId: "conversation-1",
        sourceTaskId: "task-1",
        depth: 0,
        idempotencyKey: "pi:message-1:call-1",
        createdAt: 1_000,
      },
      content: "The build is green on my branch.",
    };

    const response = await h.handler.inbound(
      new Request("http://session/internal/cross-session-inbound", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(delivery),
      })
    );

    expect(response.status).toBe(200);
    expect(h.enqueuePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "agent",
        // The initiator is named in the provenance, not made a participant.
        authorId: "cross-session:session-1",
        originContext: expect.objectContaining({
          kind: "cross_session",
          sourceSessionId: "session-1",
          humanActorId: "user-1",
          depth: 0,
        }),
      })
    );
  });

  it("refuses a delivery addressed to another session", async () => {
    const h = harness();
    const delivery = {
      receipt: {
        receiptId: "xsr_1",
        sourceSessionId: "session-1",
        targetSessionId: "session-9",
        humanActorId: "user-1",
        agentConversationId: null,
        sourceTaskId: null,
        depth: 0,
        idempotencyKey: "pi:message-1:call-1",
        createdAt: 1_000,
      },
      content: "hello",
    };

    const response = await h.handler.inbound(
      new Request("http://session/internal/cross-session-inbound", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(delivery),
      })
    );

    expect(response.status).toBe(404);
    expect(h.enqueuePrompt).not.toHaveBeenCalled();
  });

  it("refuses a delivery whose receipt it cannot confirm", async () => {
    const h = harness();

    const response = await h.handler.inbound(
      new Request("http://session/internal/cross-session-inbound", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          receipt: {
            receiptId: "xsr_forged",
            sourceSessionId: "session-1",
            targetSessionId: "session-1",
            humanActorId: "user-1",
            agentConversationId: null,
            sourceTaskId: null,
            depth: 0,
            idempotencyKey: "pi:forged",
            createdAt: 1000,
          },
          content: "hello",
        }),
      })
    );

    expect(response.status).toBe(409);
    expect(h.enqueuePrompt).not.toHaveBeenCalled();
  });

  it("refuses a delivery when the target does not accept agent messages", async () => {
    const h = harness({ sessionCapability: "off" });
    h.seedReceipt();

    const response = await h.handler.inbound(
      new Request("http://session/internal/cross-session-inbound", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          receipt: {
            receiptId: "xsr_1",
            sourceSessionId: "session-1",
            targetSessionId: "session-1",
            humanActorId: "user-1",
            agentConversationId: null,
            sourceTaskId: null,
            depth: 0,
            idempotencyKey: "pi:message-1:call-1",
            createdAt: 1000,
          },
          content: "hello",
        }),
      })
    );

    expect(response.status).toBe(403);
    expect(h.enqueuePrompt).not.toHaveBeenCalled();
  });

  it("refuses a send when the actor lost authority in the source session", async () => {
    const h = harness({
      sourceDecision: { kind: "denied", reason: "The actor may no longer collaborate" },
    });

    const response = await h.handler.outbound(outboundRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "cross_session_source_denied",
    });
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("refuses a send whose turn does not belong to this session", async () => {
    const h = harness();
    h.bridge.operationBelongsToSession = () => false;

    const response = await h.handler.outbound(outboundRequest());

    expect(response.status).toBe(403);
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it("refuses a delivery the target can no longer authorize", async () => {
    const h = harness({ decision: { kind: "denied", reason: "the actor lost membership" } });
    h.seedReceipt();
    const delivery = {
      receipt: {
        receiptId: "xsr_1",
        sourceSessionId: "session-1",
        targetSessionId: "session-1",
        humanActorId: "user-1",
        agentConversationId: null,
        sourceTaskId: null,
        depth: 0,
        idempotencyKey: "pi:message-1:call-1",
        createdAt: 1_000,
      },
      content: "hello",
    };

    const response = await h.handler.inbound(
      new Request("http://session/internal/cross-session-inbound", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(delivery),
      })
    );

    expect(response.status).toBe(403);
    expect(h.enqueuePrompt).not.toHaveBeenCalled();
  });
});
