import { describe, expect, it, vi } from "vitest";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import { createBudgetGateProvider } from "./budget-gate";
import { armTurnDeadline } from "./turn-deadline";

interface ReferenceProvider {
  stream(): Promise<string>;
}

/**
 * A deliberately small second adapter for the in-process harness seam.
 *
 * It has no runtime-specific imports. One turn crosses the same boundaries a
 * production adapter must cross: fresh authorization, a pre-call budget gate,
 * an in-object deadline, canonical event projection, and transcript export.
 */
class ReferenceHarness {
  private readonly events: SandboxEvent[] = [];

  constructor(
    private readonly authorize: () => Promise<void>,
    private readonly readBudget: () => Promise<{
      exhausted: boolean;
      spentUsd: number;
      capUsd: number | null;
    }>,
    private readonly provider: ReferenceProvider
  ) {}

  async run(messageId: string): Promise<void> {
    await this.authorize();
    const deadline = armTurnDeadline({
      deadlineMs: Date.now() + 1_000,
      onExpire: () => {
        throw new Error("Reference harness deadline expired");
      },
    });
    try {
      const provider = createBudgetGateProvider(this.provider, this.readBudget);
      const content = await provider.stream();
      this.events.push({
        type: "token",
        sandboxId: "reference-harness",
        timestamp: 1,
        messageId,
        content,
      });
      this.events.push({
        type: "execution_complete",
        sandboxId: "reference-harness",
        timestamp: 2,
        messageId,
        success: true,
      });
    } finally {
      deadline.clear();
    }
  }

  exportTrace(): ReadonlyArray<SandboxEvent> {
    return structuredClone(this.events);
  }
}

describe("the reference harness", () => {
  it("drives authorization, budget, deadline, event projection, and export through the seam", async () => {
    const authorize = vi.fn(async () => {});
    const provider = { stream: vi.fn(async () => "hello") };
    const harness = new ReferenceHarness(
      authorize,
      async () => ({ exhausted: false, spentUsd: 0, capUsd: 1 }),
      provider
    );

    await harness.run("message-1");

    expect(authorize).toHaveBeenCalledOnce();
    expect(provider.stream).toHaveBeenCalledOnce();
    expect(harness.exportTrace().map((event) => event.type)).toEqual([
      "token",
      "execution_complete",
    ]);
  });

  it("stops at the budget boundary before the provider can spend", async () => {
    const provider = { stream: vi.fn(async () => "unreachable") };
    const harness = new ReferenceHarness(
      async () => {},
      async () => ({ exhausted: true, spentUsd: 1, capUsd: 1 }),
      provider
    );

    await expect(harness.run("message-1")).rejects.toThrow(
      "The session's cost limit has been reached"
    );
    expect(provider.stream).not.toHaveBeenCalled();
    expect(harness.exportTrace()).toEqual([]);
  });
});
