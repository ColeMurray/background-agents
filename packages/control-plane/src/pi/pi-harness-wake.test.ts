import { describe, expect, it, vi } from "vitest";
import { PiHarnessWakeController, type ResumablePiHarness } from "./pi-harness-wake";

function harness(overrides: Partial<ResumablePiHarness> = {}) {
  return {
    resume: vi.fn(),
    ...overrides,
  } satisfies ResumablePiHarness;
}

describe("PiHarnessWakeController", () => {
  it("resumes the harness", () => {
    const target = harness();
    const controller = new PiHarnessWakeController({
      harness: target,
      hasPendingWork: async () => false,
      nextDeadline: async () => null,
    });

    controller.resume();
    controller.resume();

    expect(target.resume).toHaveBeenCalledTimes(2);
    expect(controller.resumes).toBe(2);
  });

  it("reports active work so the host keeps the object alive", async () => {
    const controller = new PiHarnessWakeController({
      harness: harness(),
      hasPendingWork: async () => true,
      nextDeadline: async () => null,
    });

    await expect(controller.wake()).resolves.toEqual({ active: true });
  });

  it("reports the earliest durable deadline when idle", async () => {
    const controller = new PiHarnessWakeController({
      harness: harness(),
      hasPendingWork: async () => false,
      nextDeadline: async () => 1_700_000_000_000,
    });

    await expect(controller.wake()).resolves.toEqual({
      active: false,
      at: 1_700_000_000_000,
    });
  });

  it("reports no wake when nothing is pending", async () => {
    const controller = new PiHarnessWakeController({
      harness: harness(),
      hasPendingWork: async () => false,
      nextDeadline: async () => null,
    });

    await expect(controller.wake()).resolves.toEqual({ active: false });
  });

  it("prefers the native wake contract when the harness exposes it", async () => {
    const target = harness({ wake: () => ({ active: false, at: 42 }) });
    const controller = new PiHarnessWakeController({
      harness: target,
      hasPendingWork: async () => true,
      nextDeadline: async () => 7,
    });

    await expect(controller.wake()).resolves.toEqual({ active: false, at: 42 });
    expect(controller.nativeWakeSupported).toBe(true);
  });

  it("reports that the derived wake is in use on the published release", () => {
    const controller = new PiHarnessWakeController({
      harness: harness(),
      hasPendingWork: async () => false,
      nextDeadline: async () => null,
    });

    expect(controller.nativeWakeSupported).toBe(false);
  });
});
