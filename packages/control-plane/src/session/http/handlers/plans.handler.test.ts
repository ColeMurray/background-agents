import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../../logger";
import type { PlanService } from "../../services/plan.service";
import { createPlansHandler } from "./plans.handler";

function createHandler() {
  const planService = {
    savePlan: vi.fn(),
    getCurrentPlan: vi.fn(),
    listPlans: vi.fn(),
  } as unknown as PlanService;

  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;

  const broadcast = vi.fn();
  const getPlanApprovalStatus = vi.fn().mockReturnValue(null);
  const validateReasoningEffort = vi.fn(
    (_model: string, effort: string | undefined) => effort ?? null
  );
  return {
    handler: createPlansHandler({
      planService,
      getLog: () => log,
      broadcast,
      getPlanApprovalStatus,
      validateReasoningEffort,
    }),
    planService,
    log,
    broadcast,
    getPlanApprovalStatus,
    validateReasoningEffort,
  };
}

describe("plansHandler.savePlan", () => {
  it("returns 201 with the saved plan", async () => {
    const { handler, planService } = createHandler();
    vi.mocked(planService.savePlan).mockReturnValue({
      plan: {
        id: "p1",
        version: 1,
        content: "step",
        createdByAuthorId: null,
        createdByMessageId: null,
        source: "api",
        createdAt: 1,
      },
      approvalGated: false,
      deduped: false,
    });

    const response = await handler.savePlan(
      new Request("http://internal/internal/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "step" }),
      })
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      plan: {
        id: "p1",
        version: 1,
        content: "step",
        createdByAuthorId: null,
        createdByMessageId: null,
        source: "api",
        createdAt: 1,
      },
      approvalGated: false,
    });
  });

  it("returns 400 on invalid JSON", async () => {
    const { handler } = createHandler();
    const response = await handler.savePlan(
      new Request("http://internal/internal/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      })
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when content is missing", async () => {
    const { handler, planService } = createHandler();
    const response = await handler.savePlan(
      new Request("http://internal/internal/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
    );
    expect(response.status).toBe(400);
    expect(planService.savePlan).not.toHaveBeenCalled();
  });

  it("returns 400 when service rejects", async () => {
    const { handler, planService } = createHandler();
    vi.mocked(planService.savePlan).mockImplementation(() => {
      throw new Error("Plan content cannot be empty");
    });

    const response = await handler.savePlan(
      new Request("http://internal/internal/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "   " }),
      })
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Plan content cannot be empty" });
  });
});

describe("plansHandler.getCurrentPlan", () => {
  it("returns the current plan or null", async () => {
    const { handler, planService } = createHandler();
    vi.mocked(planService.getCurrentPlan).mockReturnValue(null);
    const res = handler.getCurrentPlan();
    expect(await res.json()).toEqual({ plan: null, status: null });
  });
});

describe("plansHandler.listPlans", () => {
  it("clamps limit and forwards to the service", () => {
    const { handler, planService } = createHandler();
    vi.mocked(planService.listPlans).mockReturnValue([]);

    handler.listPlans(new URL("http://internal/internal/plans?limit=500"));
    expect(planService.listPlans).toHaveBeenCalledWith(100);

    handler.listPlans(new URL("http://internal/internal/plans?limit=10"));
    expect(planService.listPlans).toHaveBeenCalledWith(10);

    handler.listPlans(new URL("http://internal/internal/plans"));
    expect(planService.listPlans).toHaveBeenCalledWith(20);

    handler.listPlans(new URL("http://internal/internal/plans?limit=abc"));
    expect(planService.listPlans).toHaveBeenLastCalledWith(20);
  });
});
