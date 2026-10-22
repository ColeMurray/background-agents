import { describe, expect, it, vi } from "vitest";
import { HarnessEventHandler } from "./harness-event.handler";

function request(operationId = "message-1", sequence = 1, displayId = "message-1:token") {
  return new Request("http://session/internal/pi-event", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Pi-Operation-ID": operationId,
      "X-Pi-Projection-ID": displayId,
      "X-Pi-Projection-Sequence": String(sequence),
    },
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

const readEnvelope = (input: Request) => {
  const operationId = input.headers.get("X-Pi-Operation-ID");
  const displayId = input.headers.get("X-Pi-Projection-ID");
  const sequence = Number(input.headers.get("X-Pi-Projection-Sequence"));
  return operationId && displayId && Number.isSafeInteger(sequence)
    ? { operationId, displayId, sequence }
    : null;
};
const projectionAckId = (displayId: string) => `pi-projection:${displayId}`;

describe("HarnessEventHandler", () => {
  it("acknowledges each immutable sequence once", async () => {
    let lastProjectionSequence = 0;
    const operations = {
      get: vi.fn(() => ({
        operationId: "message-1",
        state: "admitted" as const,
        lastProjectionSequence,
      })),
      advanceProjection: vi.fn((_operationId: string, expected: number, sequence: number) => {
        if (lastProjectionSequence !== expected) return false;
        lastProjectionSequence = sequence;
        return true;
      }),
    };
    const processEvent = vi.fn(async () => {});
    const observeVisible = vi.fn();
    const handler = new HarnessEventHandler(
      operations,
      processEvent,
      () => true,
      readEnvelope,
      projectionAckId,
      () => 456,
      observeVisible
    );

    expect((await handler.handle(request())).status).toBe(200);
    expect(processEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "token",
        messageId: "message-1",
        ackId: "pi-projection:message-1:token",
      })
    );
    expect(operations.advanceProjection).toHaveBeenCalledWith("message-1", 0, 1, 456);
    expect(observeVisible).toHaveBeenCalledWith({
      operationId: "message-1",
      sequence: 1,
      type: "token",
      timestampMs: 456,
    });

    expect(await (await handler.handle(request())).json()).toEqual({
      status: "already_projected",
    });
    expect(processEvent).toHaveBeenCalledTimes(1);
  });

  it("accepts a late projection for a known old operation while a newer one processes", async () => {
    const operations = {
      get: () => ({
        operationId: "message-a",
        state: "settled" as const,
        lastProjectionSequence: 0,
      }),
      advanceProjection: vi.fn(() => true),
    };
    const processEvent = vi.fn(async () => {});
    const handler = new HarnessEventHandler(
      operations,
      processEvent,
      () => true,
      readEnvelope,
      projectionAckId
    );

    const response = await handler.handle(request("message-a", 1, "message-a:tool:final"));

    expect(response.status).toBe(200);
    expect(processEvent).toHaveBeenCalledOnce();
  });

  it("rejects an unknown operation and an out-of-order sequence deterministically", async () => {
    const processEvent = vi.fn(async () => {});
    const unknown = new HarnessEventHandler(
      { get: () => null, advanceProjection: vi.fn(() => false) },
      processEvent,
      () => true,
      readEnvelope,
      projectionAckId
    );
    expect((await unknown.handle(request())).status).toBe(409);

    const gap = new HarnessEventHandler(
      {
        get: () => ({
          operationId: "message-1",
          state: "admitted" as const,
          lastProjectionSequence: 1,
        }),
        advanceProjection: vi.fn(() => false),
      },
      processEvent,
      () => true,
      readEnvelope,
      projectionAckId
    );
    expect((await gap.handle(request("message-1", 3))).status).toBe(409);
    expect(processEvent).not.toHaveBeenCalled();
  });
});
