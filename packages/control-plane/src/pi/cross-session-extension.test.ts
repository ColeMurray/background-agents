import { describe, expect, it, vi } from "vitest";
import {
  createCrossSessionExtension,
  createCrossSessionPolicyDelegate,
} from "./cross-session-extension";

function harness(result: {
  receiptId: string;
  status: "delivered" | "duplicate" | "rejected";
  messageId: string | null;
  reason: string | null;
}) {
  const send = vi.fn(async () => result);
  const extension = createCrossSessionExtension({ client: { send } });
  const tool = extension.tools?.[0];
  if (!tool) throw new Error("The extension contributes no tool");
  return { tool, send };
}

const api = {
  callId: "call-1",
  taskId: 7,
  conversationId: "conversation-1",
} as never;

const context = { abortSignal: undefined } as never;

describe("cross session extension", () => {
  it("hands the message to the owning session and nothing else", async () => {
    const h = harness({
      receiptId: "xsr_1",
      status: "delivered",
      messageId: "message-1",
      reason: null,
    });

    const result = await h.tool.execute(
      { targetSessionId: "session-2", content: "The build is green." },
      api,
      context
    );

    expect(result.isError).toBe(false);
    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSessionId: "session-2",
        content: "The build is green.",
        // The same tool call always produces the same request key.
        idempotencyKey: "pi:7:call-1",
        agentConversationId: "conversation-1",
        sourceTaskId: "7",
      }),
      undefined
    );
  });

  it("reports a refused delivery instead of claiming success", async () => {
    const h = harness({
      receiptId: "xsr_1",
      status: "rejected",
      messageId: null,
      reason: "The actor may not collaborate in the target session",
    });

    const result = await h.tool.execute(
      { targetSessionId: "session-2", content: "hello" },
      api,
      context
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.output)).toContain(
      "The actor may not collaborate in the target session"
    );
  });

  it("treats an already delivered message as delivered", async () => {
    const h = harness({
      receiptId: "xsr_1",
      status: "duplicate",
      messageId: "message-1",
      reason: null,
    });

    const result = await h.tool.execute(
      { targetSessionId: "session-2", content: "hello" },
      api,
      context
    );

    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.output)).toContain("already delivered");
  });
});

describe("cross session policy delegate", () => {
  const declaration = { name: "message_session", effect: "external_mutation" } as never;
  const call = { id: "call-1", name: "message_session", arguments: {} } as never;

  it("lets the turn proceed when the owning session authorizes it", async () => {
    const authorize = vi.fn(async () => ({ allowed: true }));
    const delegate = createCrossSessionPolicyDelegate({ client: { authorize } });

    await expect(
      delegate.beforeTool?.(call, declaration, {} as never, context)
    ).resolves.toBeUndefined();
    expect(authorize).toHaveBeenCalledOnce();
  });

  it("blocks the turn with the session's own reason when it refuses", async () => {
    const authorize = vi.fn(async () => ({
      allowed: false,
      code: "cross_session_messaging_disabled",
      reason: "Cross-session messaging is disabled for this session",
    }));
    const delegate = createCrossSessionPolicyDelegate({ client: { authorize } });

    await expect(delegate.beforeTool?.(call, declaration, {} as never, context)).resolves.toEqual({
      block: "Cross-session messaging is disabled for this session",
    });
  });

  it("blocks the turn when the owning session cannot be asked", async () => {
    const authorize = vi.fn(async () => {
      throw new Error("The session is unreachable");
    });
    const delegate = createCrossSessionPolicyDelegate({ client: { authorize } });

    await expect(delegate.beforeTool?.(call, declaration, {} as never, context)).resolves.toEqual({
      block: "The session is unreachable",
    });
  });

  it("leaves a tool of another capability alone", async () => {
    const authorize = vi.fn(async () => ({ allowed: false, reason: "no" }));
    const delegate = createCrossSessionPolicyDelegate({ client: { authorize } });

    await expect(
      delegate.beforeTool?.(
        { id: "call-2", name: "repository_read", arguments: {} } as never,
        { name: "repository_read", effect: "external_read" } as never,
        {} as never,
        context
      )
    ).resolves.toBeUndefined();
    expect(authorize).not.toHaveBeenCalled();
  });
});
