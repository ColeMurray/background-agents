import { DEFAULT_COST_WARNING_THRESHOLD_PCT } from "@open-inspect/shared/types/integrations";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import { parsePersistedSandboxSettings } from "../sandbox/settings";
import { evaluateBudget, hasPositiveTokenUsage } from "./budget";
import type { EventRepository } from "./event-repository";
import type { SessionMessenger } from "./messenger";
import type { BudgetStopPreparation } from "./message-queue-types";
import type { SessionCoreRepository } from "./session-core-repository";
import type { SessionRow } from "./types";

type PrepareBudgetStop = (reason: string, now: number) => BudgetStopPreparation;
type DeliverBudgetStop = (preparation: BudgetStopPreparation) => Promise<void>;

export class SessionBudgetService {
  constructor(
    private readonly repository: SessionCoreRepository,
    private readonly eventRepository: EventRepository,
    private readonly messenger: SessionMessenger,
    private readonly prepareBudgetStop: PrepareBudgetStop,
    private readonly deliverBudgetStop: DeliverBudgetStop,
    private readonly processMessageQueue: () => Promise<void>,
    private readonly generateId: () => string
  ) {}

  async evaluateObservedCost(
    totalCost: number,
    messageId: string | null,
    now: number
  ): Promise<void> {
    const session = this.repository.getSession();
    if (!session) return;

    const action = evaluateBudget({
      totalCost,
      maxCostUsd: session.max_cost_usd,
      warningThresholdPct: this.warningThreshold(session),
      warningSent: session.cost_warning_sent === 1,
      exhausted: session.budget_exhausted === 1,
    });
    if (action === "none") return;

    if (action === "warn") {
      const message = `Session cost ${formatCost(totalCost)} reached ${this.warningThreshold(session)}% of the ${formatCost(session.max_cost_usd!)} limit.`;
      let warningEvent!: Extract<SandboxEvent, { type: "warning" }>;
      this.repository.transaction(() => {
        this.repository.markCostWarningSent(now);
        warningEvent = this.persistWarning(message, messageId, now);
      });
      this.messenger.broadcast({ type: "sandbox_event", event: warningEvent });
      this.broadcastStatus();
      return;
    }

    const limit = session.max_cost_usd!;
    const reason = `Session cost limit reached: ${formatCost(totalCost)} of ${formatCost(limit)}`;
    let preparation!: BudgetStopPreparation;
    let warningEvent!: Extract<SandboxEvent, { type: "warning" }>;
    this.repository.transaction(() => {
      preparation = this.prepareBudgetStop(reason, now);
      this.repository.markBudgetExhausted(now);
      warningEvent = this.persistWarning(
        `${reason}. ${preparation.stopped ? "Execution stopped." : "Work paused."}`,
        messageId,
        now
      );
    });
    this.messenger.broadcast({ type: "sandbox_event", event: warningEvent });
    this.broadcastStatus();
    await this.deliverBudgetStop(preparation);
  }

  recordCostTrackingUnavailable(tokens: unknown, messageId: string | null, now: number): void {
    const session = this.repository.getSession();
    if (!session || session.cost_tracking_unavailable === 1 || !hasPositiveTokenUsage(tokens))
      return;

    let warningEvent!: Extract<SandboxEvent, { type: "warning" }>;
    this.repository.transaction(() => {
      this.repository.markCostTrackingUnavailable(now);
      warningEvent = this.persistWarning(
        "Cost tracking was unavailable for a positive-token step; the session cost limit may be incomplete.",
        messageId,
        now
      );
    });
    this.messenger.broadcast({ type: "sandbox_event", event: warningEvent });
    this.broadcastStatus();
  }

  async updateLimit(maxCostUsd: number | null, now: number): Promise<void> {
    const session = this.repository.getSession();
    if (!session || Object.is(session.max_cost_usd, maxCostUsd)) return;

    const remainsExhausted =
      session.budget_exhausted === 1 && maxCostUsd !== null && session.total_cost >= maxCostUsd;
    if (remainsExhausted) {
      this.repository.setSessionBudget(maxCostUsd, { warningSent: false, exhausted: true }, now);
      this.broadcastStatus();
      return;
    }

    const action = evaluateBudget({
      totalCost: session.total_cost,
      maxCostUsd,
      warningThresholdPct: this.warningThreshold(session),
      warningSent: false,
      exhausted: false,
    });
    let warningEvent: Extract<SandboxEvent, { type: "warning" }> | null = null;

    if (action === "exhaust") {
      const reason = `Session cost limit reached: ${formatCost(session.total_cost)} of ${formatCost(maxCostUsd!)}`;
      let preparation!: BudgetStopPreparation;
      let exhaustionEvent!: Extract<SandboxEvent, { type: "warning" }>;
      this.repository.transaction(() => {
        preparation = this.prepareBudgetStop(reason, now);
        this.repository.setSessionBudget(maxCostUsd, { warningSent: false, exhausted: true }, now);
        exhaustionEvent = this.persistWarning(
          `${reason}. ${preparation.stopped ? "Execution stopped." : "Work paused."}`,
          null,
          now
        );
      });
      this.messenger.broadcast({ type: "sandbox_event", event: exhaustionEvent });
      this.broadcastStatus();
      await this.deliverBudgetStop(preparation);
      return;
    } else {
      this.repository.transaction(() => {
        this.repository.setSessionBudget(
          maxCostUsd,
          { warningSent: action === "warn", exhausted: false },
          now
        );
        if (action === "warn") {
          warningEvent = this.persistWarning(
            `Session cost ${formatCost(session.total_cost)} reached ${this.warningThreshold(session)}% of the ${formatCost(maxCostUsd!)} limit.`,
            null,
            now
          );
        }
      });
    }

    if (warningEvent) {
      this.messenger.broadcast({ type: "sandbox_event", event: warningEvent });
    }
    this.broadcastStatus();
    await this.processMessageQueue();
  }

  broadcastStatus(): void {
    const session = this.repository.getSession();
    if (!session) return;
    this.messenger.broadcast({
      type: "budget_status",
      totalCost: session.total_cost,
      maxSessionCostUsd: session.max_cost_usd,
      budgetExhausted: session.budget_exhausted === 1,
      costTrackingUnavailable: session.cost_tracking_unavailable === 1,
    });
  }

  private warningThreshold(session: SessionRow): number {
    try {
      return (
        parsePersistedSandboxSettings(session.sandbox_settings).costWarningThresholdPct ??
        DEFAULT_COST_WARNING_THRESHOLD_PCT
      );
    } catch {
      return DEFAULT_COST_WARNING_THRESHOLD_PCT;
    }
  }

  private persistWarning(
    message: string,
    messageId: string | null,
    now: number
  ): Extract<SandboxEvent, { type: "warning" }> {
    const event: Extract<SandboxEvent, { type: "warning" }> = {
      type: "warning",
      scope: "budget",
      message,
      timestamp: now / 1000,
    };
    this.eventRepository.createEvent({
      id: this.generateId(),
      type: "warning",
      data: JSON.stringify(event),
      messageId,
      createdAt: now,
    });
    return event;
  }
}

function formatCost(value: number): string {
  return `$${value.toFixed(2)}`;
}
