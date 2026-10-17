import { describe, expect, it, vi } from "vitest";
import type { MessageRepository } from "../../message-repository";
import { PiResultHandler } from "./pi-result.handler";

function request(body: unknown): Request {
  return new Request("http://session/internal/pi-result", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function buildHandler() {
  const messages = {
    getProcessingMessage: vi.fn<() => { id: string } | null>(() => ({ id: "message-1" })),
    getMessageById: vi.fn<() => { status: string; error_message: string | null } | null>(
      () => null
    ),
  };
  const processEvent = vi.fn(async () => {});
  const receipts = { has: vi.fn(() => false), record: vi.fn() };
  const recoverTerminal = vi.fn(async () => {});
  return {
    handler: new PiResultHandler(
      messages as unknown as MessageRepository,
      processEvent,
      receipts,
      recoverTerminal,
      () => true,
      () => "session-1",
      () => 1_234_000
    ),
    messages,
    processEvent,
    receipts,
    recoverTerminal,
  };
}

describe("PiResultHandler", () => {
  it("projects a terminal answer through the normalized event processor", async () => {
    const h = buildHandler();
    const response = await h.handler.handle(
      request({ operationId: "message-1", status: "done", text: "Answer" })
    );

    expect(response.status).toBe(200);
    expect(h.processEvent).toHaveBeenNthCalledWith(1, {
      type: "token",
      sandboxId: "pi:session-1",
      timestamp: 1234,
      messageId: "message-1",
      content: "Answer",
      partId: "message-1",
    });
    expect(h.processEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: "execution_complete", success: true })
    );
    expect(h.receipts.record).toHaveBeenCalledWith("message-1", 1_234_000);
  });

  it("acknowledges a replay after the message already settled", async () => {
    const h = buildHandler();
    h.messages.getProcessingMessage.mockReturnValue(null);
    h.messages.getMessageById.mockReturnValue({ status: "completed", error_message: null });

    const response = await h.handler.handle(
      request({ operationId: "message-1", status: "done", text: "Answer" })
    );

    expect(await response.json()).toEqual({ status: "recovered" });
    expect(h.processEvent).not.toHaveBeenCalled();
    expect(h.recoverTerminal).toHaveBeenCalledWith({
      operationId: "message-1",
      success: true,
    });
    expect(h.receipts.record).toHaveBeenCalledWith("message-1", 1_234_000);
  });

  it("recovers a stopped message from its persisted failure rather than a late Pi success", async () => {
    const h = buildHandler();
    h.messages.getProcessingMessage.mockReturnValue(null);
    h.messages.getMessageById.mockReturnValue({
      status: "failed",
      error_message: "Execution was stopped",
    });

    const response = await h.handler.handle(
      request({ operationId: "message-1", status: "done", text: "Late answer" })
    );

    expect(await response.json()).toEqual({ status: "recovered" });
    expect(h.recoverTerminal).toHaveBeenCalledWith({
      operationId: "message-1",
      success: false,
      error: "Execution was stopped",
    });
  });

  it("rejects a result that does not own the processing claim", async () => {
    const h = buildHandler();
    const response = await h.handler.handle(
      request({ operationId: "other", status: "done", text: "Answer" })
    );

    expect(response.status).toBe(409);
    expect(h.processEvent).not.toHaveBeenCalled();
  });

  it("rejects results for sandbox-backed sessions", async () => {
    const h = buildHandler();
    const handler = new PiResultHandler(
      h.messages as unknown as MessageRepository,
      h.processEvent,
      h.receipts,
      h.recoverTerminal,
      () => false,
      () => "session-1",
      () => 1_234_000
    );

    const response = await handler.handle(
      request({ operationId: "message-1", status: "done", text: "Answer" })
    );

    expect(response.status).toBe(409);
    expect(h.processEvent).not.toHaveBeenCalled();
  });

  it("acknowledges a fully projected receipt without replaying work", async () => {
    const h = buildHandler();
    h.receipts.has.mockReturnValue(true);

    const response = await h.handler.handle(
      request({ operationId: "message-1", status: "done", text: "Answer" })
    );

    expect(await response.json()).toEqual({ status: "already_projected" });
    expect(h.processEvent).not.toHaveBeenCalled();
    expect(h.recoverTerminal).not.toHaveBeenCalled();
  });
});
