import { describe, expect, it, vi } from "vitest";
import { createCrossSessionExtension } from "./cross-session-extension";

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
