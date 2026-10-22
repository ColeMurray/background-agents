import { describe, expect, it, vi } from "vitest";
import { SessionBudgetService } from "./budget-service";

describe("SessionBudgetService Pi exhaustion", () => {
  it("routes a running Pi step across a tiny cap through exact Pi stop", async () => {
    const session = {
      total_cost: 0,
      max_cost_usd: 0.0001,
      budget_exhausted: 0,
    };
    const repository = {
      transaction: <T>(closure: () => T) => closure(),
      addSessionCost: vi.fn((delta: number) => {
        session.total_cost += delta;
        return session.total_cost;
      }),
      getSession: vi.fn(() => session),
      markBudgetExhausted: vi.fn(() => {
        session.budget_exhausted = 1;
      }),
    };
    const executionStop = { prepare: vi.fn(), deliver: vi.fn(async () => {}) };
    const stopInProcessExecution = vi.fn(async () => {});
    const service = new SessionBudgetService(
      repository as never,
      { raiseReportedCost: () => 0.0002 },
      { createEvent: vi.fn() } as never,
      { broadcast: vi.fn() } as never,
      executionStop as never,
      async () => {},
      () => "warning-1",
      { isInProcessSession: () => true, stopInProcessExecution }
    );

    await service.ingestStepFinish(
      {
        type: "step_finish",
        sandboxId: "pi:session-1",
        timestamp: 1,
        messageId: "message-1",
        stepId: "pi-entry:1",
        cost: 0.0002,
        messageCostUsd: 0.0002,
      },
      "message-1",
      1_000
    );

    expect(stopInProcessExecution).toHaveBeenCalledWith(
      "Session cost limit reached: $0.00 of $0.00"
    );
    expect(executionStop.prepare).not.toHaveBeenCalled();
    expect(session.budget_exhausted).toBe(1);
  });
});
