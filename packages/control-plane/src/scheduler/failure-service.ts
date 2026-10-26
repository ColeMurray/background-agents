import type { AutomationStore } from "../db/automation-store";
import type { Logger } from "../logger";

/**
 * Consecutive failure threshold for auto-pause.
 *
 * Sized against concurrency rather than against a serialized automation: at a
 * `max_concurrent_runs` above one, several firings can be in flight when a
 * shared cause (a bad base branch, an expired credential) fails them, and they
 * strike in a row with no success interleaved to reset the streak. Three
 * strikes is one such round; five needs the failures to outlast it.
 */
const AUTO_PAUSE_THRESHOLD = 5;

type FailureStore = Pick<
  AutomationStore,
  | "autoPause"
  | "disableSettledOneShots"
  | "getInvocationRunAggregate"
  | "incrementConsecutiveFailures"
  | "resetConsecutiveFailures"
  | "tryMarkInvocationFailureCounted"
>;

/** Finalize consumed schedules and apply the failure streak policy once per invocation. */
export class AutomationFailureService {
  constructor(
    private readonly store: FailureStore,
    private readonly log: Logger
  ) {}

  /**
   * Increment the automation's failure streak and auto-pause at the threshold.
   * Callers gate this per-invocation via the failure_counted_at CAS.
   */
  private async trackAutomationFailure(automationId: string): Promise<void> {
    const count = await this.store.incrementConsecutiveFailures(automationId);
    if (count >= AUTO_PAUSE_THRESHOLD) {
      await this.store.autoPause(automationId);
      this.log.warn("Automation auto-paused due to consecutive failures", {
        event: "scheduler.auto_pause",
        automation_id: automationId,
        consecutive_failures: count,
      });
    }
  }

  /**
   * Invocation-level failure/success accounting (D2). Aggregates the sibling
   * runs and applies at most one consecutive-failures strike per invocation
   * (the failure_counted_at CAS admits a single winner across concurrent
   * callbacks, launch failures, and sweeps) or — once every child completed —
   * the streak reset. Idempotent by construction: safe to call after every
   * child transition and again from the finalization sweep.
   */
  async applyInvocationOutcome(automationId: string, invocationId: string): Promise<void> {
    const aggregate = await this.store.getInvocationRunAggregate(invocationId);
    if (aggregate.total === 0) return; // childless skip — never counts
    if (aggregate.active === 0) await this.store.disableSettledOneShots(automationId);

    if (aggregate.failed > 0) {
      // A sibling waiting to retry has yet to finish. This strike could auto-pause the
      // automation and so withdraw that retry; it lands once the sibling settles instead.
      if (aggregate.retrying > 0) return;
      const won = await this.store.tryMarkInvocationFailureCounted(invocationId);
      if (!won) return;
      await this.trackAutomationFailure(automationId);
    } else if (aggregate.active === 0 && aggregate.completed === aggregate.total) {
      await this.store.resetConsecutiveFailures(automationId);
    }
  }
}
