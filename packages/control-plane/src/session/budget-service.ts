import { DEFAULT_COST_WARNING_THRESHOLD_PCT } from "@open-inspect/shared/types/integrations";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import { parsePersistedSandboxSettings } from "../sandbox/settings";
import { evaluateBudget, hasPositiveTokenUsage } from "./budget";
import type { EventRepository } from "./event-repository";
import type {
  ExecutionStopCoordinator,
  ExecutionStopPreparation,
} from "./execution-stop-coordinator";
import type { SessionMessenger } from "./messenger";
import type { SessionCoreRepository } from "./session-core-repository";
import type { SessionRow } from "./types";

interface BudgetTransition {
  warningEvent: Extract<SandboxEvent, { type: "warning" }> | null;
  stopPreparation: ExecutionStopPreparation | null;
  statusChanged: boolean;
}

const NO_BUDGET_TRANSITION: BudgetTransition = {
  warningEvent: null,
  stopPreparation: null,
  statusChanged: false,
};

export class SessionBudgetService {
  constructor(
    private readonly repository: SessionCoreRepository,
    private readonly eventRepository: EventRepository,
    private readonly messenger: SessionMessenger,
    private readonly executionStop: Pick<ExecutionStopCoordinator, "prepare" | "deliver">,
    private readonly processMessageQueue: () => Promise<void>,
    private readonly generateId: () => string
  ) {}

  async ingestStepFinish(
    event: Extract<SandboxEvent, { type: "step_finish" }>,
    messageId: string | null,
    now: number
  ): Promise<boolean> {
    let accepted = false;
    let transition = NO_BUDGET_TRANSITION;
    this.repository.transaction(() => {
      accepted = this.eventRepository.recordStepFinishReceipt({
        ackId:
          event.ackId ??
          `step_finish:legacy:${event.sandboxId}:${event.messageId}:${event.timestamp}:${event.taskCallId ?? ""}:${event.childSessionId ?? ""}`,
        messageId,
        eventJson: JSON.stringify(event),
        observedCost: event.cost ?? null,
        receivedAt: now,
      });
      if (!accepted) return;

      // A reported cost of 0 (unpriced or free models) is a real observation:
      // it adds nothing and never latches the tracking-unavailable warning.
      // Only an absent cost counts as "not tracked".
      if (typeof event.cost === "number" && Number.isFinite(event.cost) && event.cost > 0) {
        const totalCost = this.repository.addSessionCost(event.cost, now);
        transition = this.applyObservedCost(totalCost, messageId, now);
      } else if (event.cost == null) {
        transition = this.applyCostTrackingUnavailable(event.tokens, messageId, now);
      }
    });

    if (!accepted) return false;
    this.messenger.broadcast({ type: "sandbox_event", event });
    await this.deliverTransition(transition);
    return true;
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

    if (action === "exhaust" && maxCostUsd !== null) {
      const reason = `Session cost limit reached: ${formatCost(session.total_cost)} of ${formatCost(maxCostUsd)}`;
      let preparation!: ExecutionStopPreparation;
      let exhaustionEvent!: Extract<SandboxEvent, { type: "warning" }>;
      this.repository.transaction(() => {
        preparation = this.executionStop.prepare(reason, now);
        this.repository.setSessionBudget(maxCostUsd, { warningSent: false, exhausted: true }, now);
        exhaustionEvent = this.persistWarning(
          `${reason}. ${preparation.stopped ? "Execution stopped." : "Work paused."}`,
          null,
          now
        );
      });
      this.messenger.broadcast({ type: "sandbox_event", event: exhaustionEvent });
      this.broadcastStatus();
      await this.executionStop.deliver(preparation);
      return;
    } else {
      this.repository.transaction(() => {
        this.repository.setSessionBudget(
          maxCostUsd,
          { warningSent: action === "warn", exhausted: false },
          now
        );
        if (action === "warn" && maxCostUsd !== null) {
          warningEvent = this.persistWarning(
            `Session cost ${formatCost(session.total_cost)} reached ${this.warningThreshold(session)}% of the ${formatCost(maxCostUsd)} limit.`,
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

  private applyObservedCost(
    totalCost: number,
    messageId: string | null,
    now: number
  ): BudgetTransition {
    const session = this.repository.getSession();
    if (!session || session.max_cost_usd === null) return NO_BUDGET_TRANSITION;
    const limit = session.max_cost_usd;
    const threshold = this.warningThreshold(session);
    const action = evaluateBudget({
      totalCost,
      maxCostUsd: limit,
      warningThresholdPct: threshold,
      warningSent: session.cost_warning_sent === 1,
      exhausted: session.budget_exhausted === 1,
    });
    if (action === "none") return NO_BUDGET_TRANSITION;

    if (action === "warn") {
      this.repository.markCostWarningSent(now);
      return {
        warningEvent: this.persistWarning(
          `Session cost ${formatCost(totalCost)} reached ${threshold}% of the ${formatCost(limit)} limit.`,
          messageId,
          now
        ),
        stopPreparation: null,
        statusChanged: true,
      };
    }

    const reason = `Session cost limit reached: ${formatCost(totalCost)} of ${formatCost(limit)}`;
    const stopPreparation = this.executionStop.prepare(reason, now);
    this.repository.markBudgetExhausted(now);
    return {
      warningEvent: this.persistWarning(
        `${reason}. ${stopPreparation.stopped ? "Execution stopped." : "Work paused."}`,
        messageId,
        now
      ),
      stopPreparation,
      statusChanged: true,
    };
  }

  private applyCostTrackingUnavailable(
    tokens: unknown,
    messageId: string | null,
    now: number
  ): BudgetTransition {
    const session = this.repository.getSession();
    if (!session || session.cost_tracking_unavailable === 1 || !hasPositiveTokenUsage(tokens)) {
      return NO_BUDGET_TRANSITION;
    }
    this.repository.markCostTrackingUnavailable(now);
    return {
      warningEvent: this.persistWarning(
        "Cost tracking was unavailable for a positive-token step; the session cost limit may be incomplete.",
        messageId,
        now
      ),
      stopPreparation: null,
      statusChanged: true,
    };
  }

  private async deliverTransition(transition: BudgetTransition): Promise<void> {
    if (transition.warningEvent) {
      this.messenger.broadcast({ type: "sandbox_event", event: transition.warningEvent });
    }
    if (transition.statusChanged) this.broadcastStatus();
    if (transition.stopPreparation) {
      await this.executionStop.deliver(transition.stopPreparation);
    }
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
