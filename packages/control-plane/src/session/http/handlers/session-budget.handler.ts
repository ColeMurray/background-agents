import { sessionBudgetUpdateSchema } from "@open-inspect/shared/types/session-api";
import type { SessionBudgetService } from "../../budget-service";
import type { SessionCoreRepository } from "../../session-core-repository";

export class SessionBudgetHandler {
  constructor(
    private readonly repository: SessionCoreRepository,
    private readonly budgetService: SessionBudgetService,
    private readonly now: () => number
  ) {}

  async update(request: Request): Promise<Response> {
    const session = this.repository.getSession();
    if (!session) return Response.json({ error: "Session not found" }, { status: 404 });

    const parsed = sessionBudgetUpdateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "Invalid budget request" }, { status: 400 });
    }

    await this.budgetService.updateLimit(parsed.data.maxCostUsd, this.now());
    const updated = this.repository.getSession();
    if (!updated) return Response.json({ error: "Session not found" }, { status: 404 });
    return Response.json({
      totalCost: updated.total_cost,
      maxSessionCostUsd: updated.max_cost_usd,
      budgetExhausted: updated.budget_exhausted === 1,
      costTrackingUnavailable: updated.cost_tracking_unavailable === 1,
    });
  }
}
