import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { EventRepository } from "./event-repository";
import type {
  ExecutionStopCoordinator,
  ExecutionStopPreparation,
} from "./execution-stop-coordinator";
import type { MessageRepository } from "./message-repository";
import type { SessionMessenger } from "./messenger";
import type { SessionCoreRepository } from "./session-core-repository";

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
        transition = { ...this.applyObservedCost(totalCost, messageId, now), statusChanged: true };
      }
    });
    await this.deliverTransition(transition);
  }

  /** Synchronous so completion and cost can share the caller's storage transaction. */
  observeExecutionCost(event: ExecutionCompleteEvent, now: number): BudgetTransition {
    if (typeof event.messageCostUsd !== "number") return NO_BUDGET_TRANSITION;
    let transition = NO_BUDGET_TRANSITION;
    this.repository.transaction(() => {
      const delta = this.messageRepository.raiseReportedCost(
        event.messageId,
        event.messageCostUsd as number
      );
      if (delta <= 0) return;
      const totalCost = this.repository.addSessionCost(delta, now);
      transition = {
        ...this.applyObservedCost(totalCost, event.messageId, now),
        statusChanged: true,
      };
    });
    return transition;
  }

  async updateLimit(maxCostUsd: number | null, now: number): Promise<void> {
    const session = this.repository.getSession();
    if (!session || Object.is(session.max_cost_usd, maxCostUsd)) return;

    const remainsExhausted =
      session.budget_exhausted === 1 && maxCostUsd !== null && session.total_cost >= maxCostUsd;
    if (remainsExhausted) {
      this.repository.setSessionBudget(maxCostUsd, true, now);
      this.broadcastStatus();
      return;
    }

    if (maxCostUsd !== null && session.total_cost >= maxCostUsd) {
      const reason = `Session cost limit reached: ${formatCost(session.total_cost)} of ${formatCost(maxCostUsd)}`;
      let preparation!: ExecutionStopPreparation;
      let exhaustionEvent!: Extract<SandboxEvent, { type: "warning" }>;
      this.repository.transaction(() => {
        preparation = this.executionStop.prepare(reason, now);
        this.repository.setSessionBudget(maxCostUsd, true, now);
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
    }

    this.repository.setSessionBudget(maxCostUsd, false, now);
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
    if (
      !session ||
      session.max_cost_usd === null ||
      session.budget_exhausted === 1 ||
      totalCost < session.max_cost_usd
    ) {
      return NO_BUDGET_TRANSITION;
    }

    const limit = session.max_cost_usd;
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

  /** Deliver only after the transaction containing the observation has committed. */
  async deliverTransition(transition: BudgetTransition): Promise<void> {
    if (transition.warningEvent) {
      this.messenger.broadcast({ type: "sandbox_event", event: transition.warningEvent });
    }
    if (transition.statusChanged) this.broadcastStatus();
    if (transition.stopPreparation) {
      await this.executionStop.deliver(transition.stopPreparation);
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
