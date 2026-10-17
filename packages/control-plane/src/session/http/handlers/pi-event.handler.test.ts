import { describe, expect, it, vi } from "vitest";
import type { MessageRepository } from "../../message-repository";
import { PiEventHandler } from "./pi-event.handler";

function request(operationId = "message-1"): Request {
  return new Request("http://session/internal/pi-event", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Pi-Operation-ID": operationId },
    body: JSON.stringify({
      type: "token",
      sandboxId: "pi:session-1",
      timestamp: 123,
      messageId: operationId,
      content: "Hello",
      partId: operationId,
    }),
  });
}

describe("PiEventHandler", () => {
  it("projects events only for the active Pi operation", async () => {
    const processEvent = vi.fn(async () => {});
    const handler = new PiEventHandler(
      { getProcessingMessage: () => ({ id: "message-1" }) } as MessageRepository,
      processEvent,
      () => true
    );

    expect((await handler.handle(request())).status).toBe(200);
    expect(processEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "token", messageId: "message-1" })
    );
  });

  it("rejects events for a different operation", async () => {
    const processEvent = vi.fn(async () => {});
    const handler = new PiEventHandler(
      { getProcessingMessage: () => ({ id: "message-1" }) } as MessageRepository,
      processEvent,
      () => true
    );

    expect((await handler.handle(request("other"))).status).toBe(409);
    expect(processEvent).not.toHaveBeenCalled();
  });
});
