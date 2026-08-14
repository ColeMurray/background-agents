import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import { SessionMessageFinalizerService, type SessionMessageFinalizer } from "./message-finalizer";
import type { SessionMessenger } from "./messenger";
import type { SessionRepository } from "./repository";
import type { SessionTerminalMessageProjection } from "./terminal-message-projection";

const COMPLETED_AT = 2_000;

function createHarness(): {
  finalizer: SessionMessageFinalizer;
  repository: Record<string, ReturnType<typeof vi.fn>>;
  projection: { recordTerminalMessage: ReturnType<typeof vi.fn> };
  broadcast: ReturnType<typeof vi.fn>;
  waitUntil: ReturnType<typeof vi.fn>;
  log: Logger;
} {
  const repository = {
    upsertExecutionCompleteEvent: vi.fn(),
    updateMessageCompletion: vi.fn(),
    getMessageTimestamps: vi.fn(() => ({ created_at: 1_000, started_at: 1_200 })),
  };
  const projection = { recordTerminalMessage: vi.fn(async () => {}) };
  const broadcast = vi.fn();
  const waitUntil = vi.fn();
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;

  const finalizer = new SessionMessageFinalizerService(
    { waitUntil } as unknown as DurableObjectState,
    log,
    repository as unknown as SessionRepository,
    { broadcast } as unknown as SessionMessenger,
    projection as unknown as SessionTerminalMessageProjection
  );

  return { finalizer, repository, projection, broadcast, waitUntil, log };
}

describe("SessionMessageFinalizerService", () => {
  it("awaits terminal projection before publishing a sandbox completion", async () => {
    const h = createHarness();
    let resolveProjection!: () => void;
    h.projection.recordTerminalMessage.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveProjection = resolve;
      })
    );
    const event = {
      type: "execution_complete" as const,
      messageId: "msg-1",
      success: true,
      sandboxId: "sandbox-1",
      timestamp: 2,
    };

    const result = h.finalizer.finalizeSandboxCompletion(event, COMPLETED_AT);

    expect(h.repository.upsertExecutionCompleteEvent).toHaveBeenCalledWith(
      "msg-1",
      event,
      COMPLETED_AT
    );
    expect(h.repository.updateMessageCompletion).toHaveBeenCalledWith(
      "msg-1",
      "completed",
      COMPLETED_AT,
      null
    );
    expect(h.broadcast).not.toHaveBeenCalled();

    resolveProjection();
    await result;

    expect(h.projection.recordTerminalMessage).toHaveBeenCalledWith({
      messageId: "msg-1",
      messageCreatedAt: 1_000,
      terminalMessageCompletedAt: COMPLETED_AT,
    });
    expect(h.broadcast).toHaveBeenCalledWith({ type: "sandbox_event", event });
  });

  it("persists the failure details reported by the sandbox", async () => {
    const h = createHarness();
    const event = {
      type: "execution_complete" as const,
      messageId: "msg-1",
      success: false,
      error: "Agent failed",
      sandboxId: "sandbox-1",
      timestamp: 2,
    };

    await h.finalizer.finalizeSandboxCompletion(event, COMPLETED_AT);

    expect(h.repository.updateMessageCompletion).toHaveBeenCalledWith(
      "msg-1",
      "failed",
      COMPLETED_AT,
      "Agent failed"
    );
  });

  it("synchronously finalizes a synthetic failure and backgrounds its projections", () => {
    const h = createHarness();
    h.projection.recordTerminalMessage.mockReturnValue(new Promise<void>(() => {}));

    h.finalizer.finalizeSyntheticFailure(
      { id: "msg-1", createdAt: 1_000 },
      "Execution was stopped",
      COMPLETED_AT
    );

    const event = expect.objectContaining({
      type: "execution_complete",
      messageId: "msg-1",
      success: false,
      error: "Execution was stopped",
      timestamp: 2,
    });
    expect(h.repository.updateMessageCompletion).toHaveBeenCalledWith(
      "msg-1",
      "failed",
      COMPLETED_AT,
      "Execution was stopped"
    );
    expect(h.repository.upsertExecutionCompleteEvent).toHaveBeenCalledWith(
      "msg-1",
      event,
      COMPLETED_AT
    );
    expect(h.projection.recordTerminalMessage).toHaveBeenCalledWith({
      messageId: "msg-1",
      messageCreatedAt: 1_000,
      terminalMessageCompletedAt: COMPLETED_AT,
    });
    expect(h.broadcast).toHaveBeenCalledWith({ type: "sandbox_event", event });
    expect(h.waitUntil).toHaveBeenCalledOnce();
  });
});
