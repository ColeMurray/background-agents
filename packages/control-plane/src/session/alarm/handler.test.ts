import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../logger";
import { createAlarmHandler } from "./handler";

function createHandler() {
  const repository = {
    getProcessingMessageWithStartedAt: vi.fn(),
  };
  const messageQueue = {
    failStuckProcessingMessage: vi.fn<() => Promise<void>>().mockResolvedValue(),
  };
  const lifecycleManager = {
    handleAlarm: vi.fn<() => Promise<void>>().mockResolvedValue(),
  };
  const now = vi.fn(() => 2000);
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;

  const handler = createAlarmHandler({
    repository,
    messageQueue,
    lifecycleManager,
    executionTimeoutMs: 1000,
    now,
    getLog: () => log,
  });

  return {
    handler,
    repository,
    messageQueue,
    lifecycleManager,
    now,
    log,
  };
}

describe("createAlarmHandler", () => {
  it("delegates to lifecycle manager when no processing message exists", async () => {
    const { handler, repository, messageQueue, lifecycleManager, now } = createHandler();
    repository.getProcessingMessageWithStartedAt.mockReturnValue(null);

    await handler.handle();

    expect(now).not.toHaveBeenCalled();
    expect(messageQueue.failStuckProcessingMessage).not.toHaveBeenCalled();
    expect(lifecycleManager.handleAlarm).toHaveBeenCalledTimes(1);
  });

  it("does not fail processing message when execution timeout is not reached", async () => {
    const { handler, repository, messageQueue, lifecycleManager, log } = createHandler();
    repository.getProcessingMessageWithStartedAt.mockReturnValue({
      id: "message-1",
      started_at: 1500,
    });

    await handler.handle();

    expect(log.warn).not.toHaveBeenCalled();
    expect(messageQueue.failStuckProcessingMessage).not.toHaveBeenCalled();
    expect(lifecycleManager.handleAlarm).toHaveBeenCalledTimes(1);
  });

  it("fails stuck processing message when execution timeout is reached", async () => {
    const { handler, repository, messageQueue, lifecycleManager, log } = createHandler();
    repository.getProcessingMessageWithStartedAt.mockReturnValue({
      id: "message-1",
      started_at: 500,
    });

    await handler.handle();

    expect(log.warn).toHaveBeenCalledWith("Execution timeout: message stuck in processing", {
      event: "execution.timeout",
      message_id: "message-1",
      elapsed_ms: 1500,
      timeout_ms: 1000,
    });
    expect(messageQueue.failStuckProcessingMessage).toHaveBeenCalledTimes(1);
    expect(lifecycleManager.handleAlarm).toHaveBeenCalledTimes(1);
  });
});
