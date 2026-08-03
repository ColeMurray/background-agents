import { describe, expect, it, vi } from "vitest";
import { consumeImageBuildFinalizationBatch } from "./finalization-consumer";

function message(body: unknown) {
  return {
    id: "message-1",
    timestamp: new Date(),
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function batch(...messages: ReturnType<typeof message>[]): MessageBatch<unknown> {
  return {
    queue: "image-build-finalization",
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<unknown>;
}

describe("image build finalization Queue consumer", () => {
  it("acknowledges completed work", async () => {
    const queued = message({
      version: 1,
      buildId: "build-1",
      completionHash: "a".repeat(64),
    });
    const process = vi.fn(async () => ({ type: "completed" as const }));

    await consumeImageBuildFinalizationBatch(batch(queued), process);

    expect(process).toHaveBeenCalledWith(queued.body, "message-1");
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
  });

  it("retries busy or failed processing and rejects malformed commands", async () => {
    const retry = message({
      version: 1,
      buildId: "build-1",
      completionHash: "a".repeat(64),
    });
    const malformed = message({ buildId: "build-2", callbackToken: "secret" });
    const process = vi.fn(async () => ({ type: "retry" as const, delaySeconds: 365 }));

    await consumeImageBuildFinalizationBatch(batch(retry, malformed), process);

    expect(retry.retry).toHaveBeenCalledWith({ delaySeconds: 365 });
    expect(malformed.ack).toHaveBeenCalledOnce();
    expect(process).toHaveBeenCalledTimes(1);
  });
});
