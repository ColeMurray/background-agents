import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../../logger";
import type { PlanService } from "../../services/plan.service";
import { createPlansHandler } from "./plans.handler";

function createHandler() {
  const planService = {
    savePlan: vi.fn(),
    getCurrentPlan: vi.fn(),
    listPlans: vi.fn(),
    approvePlanAndFlush: vi.fn(),
    rejectPlan: vi.fn(),
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

describe("plansHandler.approvePlan / rejectPlan body validation", () => {
  // Regression tests for CodeRabbit #671 item 1.3: readApprovalBody used to
  // catch JSON.parse errors and silently return {}, masking malformed
  // client requests. It now throws InvalidApprovalBodyError, which the
  // approve/reject handlers map to HTTP 400.

  it("approvePlan returns HTTP 400 on malformed JSON body", async () => {
    const { handler, planService } = createHandler();
    const req = new Request("http://internal/internal/plan/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json", "content-length": "5" },
      body: "{not-json",
    });
    const res = await handler.approvePlan(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("invalid_body");
    expect(planService.approvePlanAndFlush).not.toHaveBeenCalled();
  });

  it("rejectPlan returns HTTP 400 on malformed JSON body", async () => {
    const { handler, planService } = createHandler();
    const req = new Request("http://internal/internal/plan/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json", "content-length": "5" },
      body: "garbage",
    });
    const res = await handler.rejectPlan(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("invalid_body");
    expect(planService.rejectPlan).not.toHaveBeenCalled();
  });

  it("approvePlan accepts empty body (no parse attempted)", async () => {
    const { handler, planService } = createHandler();
    vi.mocked(planService.approvePlanAndFlush).mockResolvedValue({
      plan: null,
      status: "approved",
      postApproval: undefined,
    } as unknown as Awaited<ReturnType<PlanService["approvePlanAndFlush"]>>);
    const req = new Request("http://internal/internal/plan/approve", {
      method: "POST",
      headers: { "content-length": "0" },
    });
    const res = await handler.approvePlan(req);
    expect(res.status).toBe(200);
    expect(planService.approvePlanAndFlush).toHaveBeenCalledWith({
      approverAuthorId: undefined,
      implementationModel: null,
      implementationReasoningEffort: undefined,
    });
  });

  it("approvePlan returns 400 when implementationReasoningEffort is sent without implementationModel", async () => {
    // Regression test for CodeRabbit #671 follow-up: previously the handler
    // silently coerced an effort sent without a model into `null`, which the
    // service treated as an explicit clear and wiped the session's existing
    // reasoning_effort.
    const { handler, planService } = createHandler();
    const req = new Request("http://internal/internal/plan/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ implementationReasoningEffort: "high" }),
    });
    const res = await handler.approvePlan(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("invalid_reasoning_effort");
    expect(planService.approvePlanAndFlush).not.toHaveBeenCalled();
  });

  it("approvePlan forwards explicit null reasoning effort to clear the value", async () => {
    const { handler, planService } = createHandler();
    vi.mocked(planService.approvePlanAndFlush).mockResolvedValue({
      plan: null,
      status: "approved",
      postApproval: undefined,
    } as unknown as Awaited<ReturnType<PlanService["approvePlanAndFlush"]>>);
    const req = new Request("http://internal/internal/plan/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ implementationReasoningEffort: null }),
    });
    const res = await handler.approvePlan(req);
    expect(res.status).toBe(200);
    expect(planService.approvePlanAndFlush).toHaveBeenCalledWith({
      approverAuthorId: undefined,
      implementationModel: null,
      implementationReasoningEffort: null,
    });
  });
});
