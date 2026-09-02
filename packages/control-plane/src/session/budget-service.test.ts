import { describe, expect, it, vi } from "vitest";
import { SessionBudgetService } from "./budget-service";
import type { EventRepository } from "./event-repository";
import type { SessionMessenger } from "./messenger";
import type { SessionCoreRepository } from "./session-core-repository";
import type { SessionRow } from "./types";
import type { ExecutionStopPreparation } from "./execution-stop-coordinator";

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "session-1",
    session_name: "public-1",
    title: null,
    repo_owner: null,
    repo_name: null,
    repo_id: null,
    base_branch: null,
    branch_name: null,
    base_sha: null,
    current_sha: null,
    opencode_session_id: null,
    model: "anthropic/claude-sonnet-4-6",
    reasoning_effort: null,
    status: "active",
    parent_session_id: null,
    spawn_source: "user",
    spawn_depth: 0,
    code_server_enabled: 0,
    vnc_enabled: 0,
    total_cost: 8,
    sandbox_settings: JSON.stringify({ costWarningThresholdPct: 80 }),
    max_cost_usd: 10,
    cost_warning_sent: 0,
    budget_exhausted: 0,
    cost_tracking_unavailable: 0,
    environment_id: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function createService(row = session()) {
  let current = row;
  const repository = {
    getSession: vi.fn(() => current),
    transaction: vi.fn((closure: () => void) => closure()),
    addSessionCost: vi.fn((cost: number) => {
      current = { ...current, total_cost: current.total_cost + cost };
      return current.total_cost;
    }),
    markCostWarningSent: vi.fn(() => {
      current = { ...current, cost_warning_sent: 1 };
    }),
    markCostTrackingUnavailable: vi.fn(() => {
      current = { ...current, cost_tracking_unavailable: 1 };
    }),
    markBudgetExhausted: vi.fn(() => {
      current = { ...current, budget_exhausted: 1 };
    }),
    setSessionBudget: vi.fn(
      (maxCostUsd: number | null, state: { warningSent: boolean; exhausted: boolean }) => {
        current = {
          ...current,
          max_cost_usd: maxCostUsd,
          cost_warning_sent: state.warningSent ? 1 : 0,
          budget_exhausted: state.exhausted ? 1 : 0,
        };
      }
    ),
  };
  const eventRepository = {
    createEvent: vi.fn(),
  };
  const reportedCosts = new Map<string, number>();
  const messageRepository = {
    raiseReportedCost: vi.fn((messageId: string, reported: number) => {
      const previous = reportedCosts.get(messageId) ?? 0;
      if (reported <= previous) return 0;
      reportedCosts.set(messageId, reported);
      return reported - previous;
    }),
  };
  const broadcast = vi.fn();
  const preparation = { stopped: true } as ExecutionStopPreparation;
  const prepareBudgetStop = vi.fn(() => preparation);
  const deliverBudgetStop = vi.fn(async () => {});
  const processMessageQueue = vi.fn(async () => {});
  const service = new SessionBudgetService(
    repository as unknown as SessionCoreRepository,
    messageRepository,
    eventRepository as unknown as EventRepository,
    { broadcast } as unknown as SessionMessenger,
    { prepare: prepareBudgetStop, deliver: deliverBudgetStop },
    processMessageQueue,
    () => "budget-event-1"
  );
  return {
    service,
    repository,
    messageRepository,
    eventRepository,
    broadcast,
    prepareBudgetStop,
    deliverBudgetStop,
    processMessageQueue,
  };
}

describe("SessionBudgetService", () => {
  it("applies a cumulative report once and repairs a dropped one", async () => {
    const h = createService(session({ total_cost: 0, max_cost_usd: 100 }));
    const event = {
      type: "step_finish" as const,
      messageId: "message-1",
      sandboxId: "sandbox-1",
      timestamp: 1,
      cost: 1,
      messageCostUsd: 1,
    };

    await h.service.ingestStepFinish(event, "message-1", 1000);
    await h.service.ingestStepFinish(event, "message-1", 1001);
    // The report for the second step was lost; the third carries both.
    await h.service.ingestStepFinish(
      { ...event, cost: 0.5, messageCostUsd: 2.5 },
      "message-1",
      1002
    );

    expect(h.repository.addSessionCost).toHaveBeenCalledTimes(2);
    expect(h.repository.addSessionCost).toHaveBeenNthCalledWith(1, 1, 1000);
    expect(h.repository.addSessionCost).toHaveBeenNthCalledWith(2, 1.5, 1002);
    expect(h.repository.transaction).toHaveBeenCalledTimes(3);
  });

  it("attributes cost to the context message when the event names another", async () => {
    const h = createService(session({ total_cost: 0, max_cost_usd: 100 }));

    await h.service.ingestStepFinish(
      {
        type: "step_finish",
        messageId: "message-1",
        sandboxId: "sandbox-1",
        timestamp: 1,
        cost: 2,
        messageCostUsd: 2,
      },
      "message-2",
      1000
    );

    expect(h.messageRepository.raiseReportedCost).toHaveBeenCalledWith("message-2", 2);
  });

  it("adds a legacy per-step cost directly when no cumulative report is present", async () => {
    const h = createService(session({ total_cost: 0, max_cost_usd: 100 }));
    const event = {
      type: "step_finish" as const,
      messageId: "message-1",
      sandboxId: "sandbox-1",
      timestamp: 1,
      cost: 1,
    };

    await h.service.ingestStepFinish(event, "message-1", 1000);
    await h.service.ingestStepFinish(event, "message-1", 1001);

    expect(h.messageRepository.raiseReportedCost).not.toHaveBeenCalled();
    expect(h.repository.addSessionCost).toHaveBeenCalledTimes(2);
  });

  it("applies the final report on execution_complete and pauses without a stop", async () => {
    const h = createService(session({ total_cost: 9 }));
    h.prepareBudgetStop.mockReturnValueOnce({ stopped: false } as ExecutionStopPreparation);

    await h.service.ingestExecutionComplete(
      {
        type: "execution_complete",
        messageId: "message-1",
        sandboxId: "sandbox-1",
        timestamp: 1,
        success: true,
        messageCostUsd: 1.5,
      },
      1000
    );

    expect(h.repository.addSessionCost).toHaveBeenCalledWith(1.5, 1000);
    expect(h.repository.markBudgetExhausted).toHaveBeenCalledWith(1000);
    expect(h.eventRepository.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.stringContaining("Work paused") })
    );
    expect(h.deliverBudgetStop).toHaveBeenCalledOnce();
  });

  it("ignores execution_complete without a cumulative report", async () => {
    const h = createService();

    await h.service.ingestExecutionComplete(
      {
        type: "execution_complete",
        messageId: "message-1",
        sandboxId: "sandbox-1",
        timestamp: 1,
        success: true,
      },
      1000
    );

    expect(h.repository.transaction).not.toHaveBeenCalled();
    expect(h.repository.addSessionCost).not.toHaveBeenCalled();
  });

  it("persists and broadcasts one threshold warning", async () => {
    const h = createService(session({ total_cost: 7 }));

    await h.service.ingestStepFinish(
      {
        type: "step_finish",
        messageId: "message-1",
        sandboxId: "sandbox-1",
        timestamp: 1,
        cost: 1,
      },
      "message-1",
      1000
    );

    expect(h.repository.transaction).toHaveBeenCalledOnce();
    expect(h.repository.markCostWarningSent).toHaveBeenCalledWith(1000);
    expect(h.eventRepository.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: "budget-event-1", type: "warning", messageId: "message-1" })
    );
    expect(h.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "sandbox_event",
        event: expect.objectContaining({ scope: "budget" }),
      })
    );
    expect(h.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "budget_status", totalCost: 8, budgetExhausted: false })
    );
  });

  it("establishes exhaustion through the budget stop path", async () => {
    const h = createService(session({ total_cost: 9.25 }));

    await h.service.ingestStepFinish(
      {
        type: "step_finish",
        messageId: "message-1",
        sandboxId: "sandbox-1",
        timestamp: 1,
        cost: 1,
      },
      "message-1",
      1000
    );

    expect(h.prepareBudgetStop).toHaveBeenCalledOnce();
    expect(h.deliverBudgetStop).toHaveBeenCalledOnce();
    expect(h.repository.markBudgetExhausted).toHaveBeenCalledWith(1000);
    expect(h.eventRepository.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.stringContaining("Execution stopped") })
    );
    expect(h.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "budget_status", totalCost: 10.25, budgetExhausted: true })
    );
  });

  it("latches omitted cost only for positive token usage", async () => {
    const h = createService();

    const event = {
      type: "step_finish" as const,
      messageId: "message-1",
      sandboxId: "sandbox-1",
      timestamp: 1,
      tokens: { input: 1 },
    };
    await h.service.ingestStepFinish(event, "message-1", 1000);
    await h.service.ingestStepFinish(event, "message-1", 1001);

    expect(h.repository.markCostTrackingUnavailable).toHaveBeenCalledOnce();
    expect(h.eventRepository.createEvent).toHaveBeenCalledOnce();
    expect(h.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "budget_status", costTrackingUnavailable: true })
    );
  });

  it("treats a reported cost of zero as observed, not untracked", async () => {
    const h = createService();

    await h.service.ingestStepFinish(
      {
        type: "step_finish",
        messageId: "message-1",
        sandboxId: "sandbox-1",
        timestamp: 1,
        cost: 0,
        tokens: { input: 500, output: 200 },
      },
      "message-1",
      1000
    );

    expect(h.repository.addSessionCost).not.toHaveBeenCalled();
    expect(h.repository.markCostTrackingUnavailable).not.toHaveBeenCalled();
    expect(h.repository.markBudgetExhausted).not.toHaveBeenCalled();
    expect(h.eventRepository.createEvent).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "budget_status" })
    );
  });

  it("updates the live limit and resumes queued work when permitted", async () => {
    const h = createService(session({ max_cost_usd: 10, budget_exhausted: 1, total_cost: 10 }));

    await h.service.updateLimit(20, 1000);

    expect(h.repository.setSessionBudget).toHaveBeenCalledWith(
      20,
      { warningSent: false, exhausted: false },
      1000
    );
    expect(h.processMessageQueue).toHaveBeenCalledOnce();
    expect(h.prepareBudgetStop).not.toHaveBeenCalled();
  });

  it("evaluates a lower live limit immediately", async () => {
    const h = createService(session({ max_cost_usd: 20, total_cost: 8 }));

    await h.service.updateLimit(9, 1000);

    expect(h.repository.setSessionBudget).toHaveBeenCalledWith(
      9,
      { warningSent: true, exhausted: false },
      1000
    );
    expect(h.eventRepository.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.stringContaining("reached 80%") })
    );
  });

  it("treats an unchanged live limit as an idempotent no-op", async () => {
    const h = createService(session({ max_cost_usd: 10 }));

    await h.service.updateLimit(10, 1000);

    expect(h.repository.setSessionBudget).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it("updates an exhausted limit without repeating stop effects", async () => {
    const h = createService(session({ max_cost_usd: 10, budget_exhausted: 1, total_cost: 12 }));

    await h.service.updateLimit(11, 1000);

    expect(h.repository.setSessionBudget).toHaveBeenCalledWith(
      11,
      { warningSent: false, exhausted: true },
      1000
    );
    expect(h.prepareBudgetStop).not.toHaveBeenCalled();
    expect(h.eventRepository.createEvent).not.toHaveBeenCalled();
  });
});
