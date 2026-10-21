import { describe, expect, it, vi } from "vitest";
import type { SandboxReadyOutcome } from "../../sandbox/lifecycle/ports";
import { SandboxRuntimeEventHandler } from "./runtime.handler";

function fixture(outcome: SandboxReadyOutcome) {
  const processMessageQueue = vi.fn(async () => undefined);
  const submit = vi.fn((work: () => Promise<void>) => void work());
  const scheduleInactivityCheck = vi.fn(async () => undefined);
  const lifecycle = { onRuntimeReady: vi.fn(() => outcome) };
  const sandboxRepository = { recordReportedSandboxRuntimeVersion: vi.fn() };
  const eventRepository = { createEvent: vi.fn() };
  const messenger = { broadcast: vi.fn() };
  const diffService = { pinBaselines: vi.fn() };
  const handler = new SandboxRuntimeEventHandler(
    { getSession: () => ({ harness: "pi" }) } as never,
    sandboxRepository as never,
    eventRepository as never,
    messenger as never,
    diffService as never,
    vi.fn(),
    vi.fn(),
    vi.fn(),
    scheduleInactivityCheck,
    { submit } as never,
    { processMessageQueue } as never,
    { warn: vi.fn() } as never,
    lifecycle
  );
  return {
    handler,
    lifecycle,
    processMessageQueue,
    scheduleInactivityCheck,
    sandboxRepository,
    eventRepository,
    messenger,
    diffService,
  };
}

describe("SandboxRuntimeEventHandler ready outcomes", () => {
  it.each(["rejected", "accepted_reconnect"] as const)(
    "does not wake the prompt queue for %s",
    async (outcome) => {
      const h = fixture(outcome);

      await expect(
        h.handler.handleReady(
          {
            type: "ready",
            sandboxId: "sandbox-1",
            timestamp: 1,
            runtimeMode: "execution",
            bridgeInstanceId: "bridge-1",
            runtimeVersion: "v78-execution-isolation-boundary",
          },
          { now: 1_000, messageId: null, processingMessage: null }
        )
      ).resolves.toBe(outcome);

      expect(h.processMessageQueue).not.toHaveBeenCalled();
      expect(h.scheduleInactivityCheck).not.toHaveBeenCalled();
      if (outcome === "rejected") {
        expect(h.sandboxRepository.recordReportedSandboxRuntimeVersion).not.toHaveBeenCalled();
        expect(h.eventRepository.createEvent).not.toHaveBeenCalled();
        expect(h.messenger.broadcast).not.toHaveBeenCalled();
        expect(h.diffService.pinBaselines).not.toHaveBeenCalled();
      }
    }
  );

  it("wakes the prompt queue only when readiness changed", async () => {
    const h = fixture("became_ready");

    await expect(
      h.handler.handleReady(
        { type: "ready", sandboxId: "sandbox-1", timestamp: 1 },
        { now: 1_000, messageId: null, processingMessage: null }
      )
    ).resolves.toBe("became_ready");

    expect(h.processMessageQueue).toHaveBeenCalledOnce();
    expect(h.scheduleInactivityCheck).toHaveBeenCalledOnce();
  });
});
