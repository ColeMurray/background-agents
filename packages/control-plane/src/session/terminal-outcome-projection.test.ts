import { describe, expect, it, vi } from "vitest";
import type { SessionIndexStore } from "../db/session-index";
import type { Logger } from "../logger";
import { SessionTerminalOutcomeProjection } from "./terminal-outcome-projection";

function createProjection(recordLatestTerminalOutcome: ReturnType<typeof vi.fn>) {
  const log = { warn: vi.fn(), error: vi.fn() };
  const projection = new SessionTerminalOutcomeProjection(
    { recordLatestTerminalOutcome } as unknown as SessionIndexStore,
    () => "session-1",
    log as unknown as Logger
  );
  return { projection, log };
}

describe("SessionTerminalOutcomeProjection", () => {
  it("retries one failed projection with the same idempotency input", async () => {
    const recordLatestTerminalOutcome = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(true);
    const { projection, log } = createProjection(recordLatestTerminalOutcome);

    await projection.recordTerminalOutcome({
      messageId: "message-1",
      messageCreatedAt: 1_000,
      terminalOutcomeCompletedAt: 2_000,
    });

    expect(recordLatestTerminalOutcome).toHaveBeenCalledTimes(2);
    expect(recordLatestTerminalOutcome).toHaveBeenNthCalledWith(1, {
      sessionId: "session-1",
      messageId: "message-1",
      messageCreatedAt: 1_000,
      terminalOutcomeCompletedAt: 2_000,
    });
    expect(recordLatestTerminalOutcome.mock.calls[1]).toEqual(
      recordLatestTerminalOutcome.mock.calls[0]
    );
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("stops after the bounded retry and records the failure", async () => {
    const recordLatestTerminalOutcome = vi.fn().mockRejectedValue(new Error("unavailable"));
    const { projection, log } = createProjection(recordLatestTerminalOutcome);

    await projection.recordTerminalOutcome({
      messageId: "message-1",
      messageCreatedAt: 1_000,
      terminalOutcomeCompletedAt: 2_000,
    });

    expect(recordLatestTerminalOutcome).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledOnce();
  });
});
