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
    getMessageById: vi.fn<() => { status: string } | null>(() => null),
  };
  const processEvent = vi.fn(async () => {});
  return {
    handler: new PiResultHandler(
      messages as unknown as MessageRepository,
      processEvent,
      () => "session-1",
      () => 1234
    ),
    messages,
    processEvent,
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
  });

  it("acknowledges a replay after the message already settled", async () => {
    const h = buildHandler();
    h.messages.getProcessingMessage.mockReturnValue(null);
    h.messages.getMessageById.mockReturnValue({ status: "completed" });

    const response = await h.handler.handle(
      request({ operationId: "message-1", status: "done", text: "Answer" })
    );

    expect(await response.json()).toEqual({ status: "already_projected" });
    expect(h.processEvent).not.toHaveBeenCalled();
  });

  it("rejects a result that does not own the processing claim", async () => {
    const h = buildHandler();
    const response = await h.handler.handle(
      request({ operationId: "other", status: "done", text: "Answer" })
    );

    expect(response.status).toBe(409);
    expect(h.processEvent).not.toHaveBeenCalled();
  });
});
