import { describe, expect, it, vi } from "vitest";
import type { SessionIndexStore } from "../db/session-index";
import type { Logger } from "../logger";
import { SessionAttentionProjection } from "./attention-projection";

function createProjection(recordLatestAttention: ReturnType<typeof vi.fn>) {
  const log = { warn: vi.fn(), error: vi.fn() };
  const projection = new SessionAttentionProjection(
    { recordLatestAttention } as unknown as SessionIndexStore,
    () => "session-1",
    log as unknown as Logger
  );
  return { projection, log };
}

describe("SessionAttentionProjection", () => {
  it("retries one failed projection with the same idempotency input", async () => {
    const recordLatestAttention = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(true);
    const { projection, log } = createProjection(recordLatestAttention);

    await projection.recordTerminalOutcome("message-1", 1_000, 2_000);

    expect(recordLatestAttention).toHaveBeenCalledTimes(2);
    expect(recordLatestAttention).toHaveBeenNthCalledWith(1, {
      sessionId: "session-1",
      messageId: "message-1",
      messageCreatedAt: 1_000,
      acceptedAt: 2_000,
    });
    expect(recordLatestAttention.mock.calls[1]).toEqual(recordLatestAttention.mock.calls[0]);
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("stops after the bounded retry and records the failure", async () => {
    const recordLatestAttention = vi.fn().mockRejectedValue(new Error("unavailable"));
    const { projection, log } = createProjection(recordLatestAttention);

    await projection.recordTerminalOutcome("message-1", 1_000, 2_000);

    expect(recordLatestAttention).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledOnce();
  });
});
