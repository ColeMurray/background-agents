import { describe, expect, it, vi } from "vitest";
import type { SessionIndexStore } from "../db/session-index";
import type { Logger } from "../logger";
import { SessionTerminalMessageProjection } from "./terminal-message-projection";

function createProjection(recordLatestTerminalMessage: ReturnType<typeof vi.fn>) {
  const log = { warn: vi.fn(), error: vi.fn() };
  const projection = new SessionTerminalMessageProjection(
    { recordLatestTerminalMessage } as unknown as SessionIndexStore,
    () => "session-1",
    log as unknown as Logger
  );
  return { projection, log };
}

describe("SessionTerminalMessageProjection", () => {
  it("retries one failed projection with the same idempotency input", async () => {
    const recordLatestTerminalMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(true);
    const { projection, log } = createProjection(recordLatestTerminalMessage);

    await projection.recordTerminalMessage({
      messageId: "message-1",
      messageCreatedAt: 1_000,
      terminalMessageCompletedAt: 2_000,
    });

    expect(recordLatestTerminalMessage).toHaveBeenCalledTimes(2);
    expect(recordLatestTerminalMessage).toHaveBeenNthCalledWith(1, {
      sessionId: "session-1",
      messageId: "message-1",
      messageCreatedAt: 1_000,
      terminalMessageCompletedAt: 2_000,
    });
    expect(recordLatestTerminalMessage.mock.calls[1]).toEqual(
      recordLatestTerminalMessage.mock.calls[0]
    );
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("stops after the bounded retry and records the failure", async () => {
    const recordLatestTerminalMessage = vi.fn().mockRejectedValue(new Error("unavailable"));
    const { projection, log } = createProjection(recordLatestTerminalMessage);

    await projection.recordTerminalMessage({
      messageId: "message-1",
      messageCreatedAt: 1_000,
      terminalMessageCompletedAt: 2_000,
    });

    expect(recordLatestTerminalMessage).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledOnce();
  });
});
