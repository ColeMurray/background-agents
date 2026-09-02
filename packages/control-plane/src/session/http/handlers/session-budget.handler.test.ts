import { describe, expect, it, vi } from "vitest";
import { SessionBudgetHandler } from "./session-budget.handler";
import type { SessionBudgetService } from "../../budget-service";
import type { SessionCoreRepository } from "../../session-core-repository";

function createHandler() {
  const session = {
    id: "session-1",
    total_cost: 8,
    max_cost_usd: 10,
    budget_exhausted: 0,
    cost_tracking_unavailable: 0,
  };
  const repository = { getSession: vi.fn(() => session) };
  const budgetService = {
    updateLimit: vi.fn(async (maxCostUsd: number | null) => {
      session.max_cost_usd = maxCostUsd as number;
      session.budget_exhausted = 0;
    }),
  };
  return {
    handler: new SessionBudgetHandler(
      repository as unknown as SessionCoreRepository,
      budgetService as unknown as SessionBudgetService,
      () => 1000
    ),
    budgetService,
  };
}

function request(body: unknown): Request {
  return new Request("http://internal/internal/budget", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("SessionBudgetHandler", () => {
  it("lets the owner update the live limit", async () => {
    const h = createHandler();
    const response = await h.handler.update(request({ maxCostUsd: 20 }));

    expect(response.status).toBe(200);
    expect(h.budgetService.updateLimit).toHaveBeenCalledWith(20, 1000);
    expect(await response.json()).toMatchObject({ maxSessionCostUsd: 20, totalCost: 8 });
  });

  it.each([{ maxCostUsd: 0 }, { maxCostUsd: -1 }, { maxCostUsd: 1, extra: true }, {}])(
    "rejects invalid body %#",
    async (body) => {
      const response = await createHandler().handler.update(request(body));
      expect(response.status).toBe(400);
    }
  );
});
