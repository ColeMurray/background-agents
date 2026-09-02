import { DEFAULT_COST_WARNING_THRESHOLD_PCT } from "@open-inspect/shared/types/integrations";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import { parsePersistedSandboxSettings } from "../sandbox/settings";
import { evaluateBudget, hasPositiveTokenUsage } from "./budget";
import type { EventRepository } from "./event-repository";
import type {
  ExecutionStopCoordinator,
  ExecutionStopPreparation,
} from "./execution-stop-coordinator";
import type { MessageRepository } from "./message-repository";
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

type StepFinishEvent = Extract<SandboxEvent, { type: "step_finish" }>;
type ExecutionCompleteEvent = Extract<SandboxEvent, { type: "execution_complete" }>;

/**
 * Cost accounting is idempotent by construction. The runtime reports the
 * cumulative cost of the current turn (`messageCostUsd`) on every step and on
 * `execution_complete`; the session total only ever moves by the amount that
 * report exceeds the highest one already recorded for the message. A resent
 * event therefore adds nothing and a dropped one is repaired by the next.
 *
 * Runtimes that predate the cumulative field still report a per-step `cost`,
 * which is added directly; that path undercounts on a dropped event.
 */
export class SessionBudgetService {
  constructor(
    private readonly repository: SessionCoreRepository,
    private readonly messageRepository: Pick<MessageRepository, "raiseReportedCost">,
    private readonly eventRepository: EventRepository,
    private readonly messenger: SessionMessenger,
    private readonly executionStop: Pick<ExecutionStopCoordinator, "prepare" | "deliver">,
    private readonly processMessageQueue: () => Promise<void>,
    private readonly generateId: () => string
  ) {}

  async ingestStepFinish(
    event: StepFinishEvent,
    messageId: string | null,
    now: number
  ): Promise<void> {
    let transition = NO_BUDGET_TRANSITION;
    this.repository.transaction(() => {
      const delta = this.observeReportedCost(event, messageId);
      if (delta > 0) {
        const totalCost = this.repository.addSessionCost(delta, now);
        transition = this.applyObservedCost(totalCost, messageId, now);
      } else if (event.cost == null) {
        // A reported cost of 0 (unpriced or free models) is a real observation
        // and never latches the warning. Only an absent cost is "not tracked".
        transition = this.applyCostTrackingUnavailable(event.tokens, messageId, now);
      }
    });
    await this.deliverTransition(transition);
  }

  async ingestExecutionComplete(event: ExecutionCompleteEvent, now: number): Promise<void> {
    if (typeof event.messageCostUsd !== "number") return;
    let transition = NO_BUDGET_TRANSITION;
    this.repository.transaction(() => {
      const delta = this.messageRepository.raiseReportedCost(
        event.messageId,
        event.messageCostUsd as number
      );
      if (delta <= 0) return;
      const totalCost = this.repository.addSessionCost(delta, now);
      transition = this.applyObservedCost(totalCost, event.messageId, now);
    });
    await this.deliverTransition(transition);
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

  /** Amount the session total should grow by for this step; 0 for resends. */
  private observeReportedCost(event: StepFinishEvent, messageId: string | null): number {
    if (typeof event.messageCostUsd === "number" && Number.isFinite(event.messageCostUsd)) {
      const target = messageId ?? event.messageId;
      return this.messageRepository.raiseReportedCost(target, event.messageCostUsd);
    }
    if (typeof event.cost === "number" && Number.isFinite(event.cost) && event.cost > 0) {
      return event.cost;
    }
    return 0;
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
