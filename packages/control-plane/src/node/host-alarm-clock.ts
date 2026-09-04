/**
 * The Node host's alarm: one timer for the whole process, armed for the
 * soonest deadline in the host alarm index, delivering to each session
 * through the host's `deliver` callback (which opens the session if it was
 * evicted and runs its scheduled-deadline handler).
 *
 * `storeFor(sessionId)` is the per-session `AlarmScheduleStore` the session
 * runtime is built over: what a Durable Object's `ctx.storage` alarm methods
 * provide. Setting a deadline records it in the index and re-arms the
 * timer. Firing *claims* the record: the session reads as disarmed while
 * its handler runs, as the platform clears a Durable Object's alarm when it
 * fires, so a handler that arms a new deadline replaces nothing; the claim
 * itself stays on disk until the delivery settles, so a process that dies
 * mid-delivery fires it again at the next start.
 *
 * A failed delivery is retried on the platform's policy (doubling backoff
 * from two seconds, six retries), sooner if the session armed something
 * sooner; the count lives in the index, so a restart does not renew it.
 * After the last attempt the host stops retrying on its own; the session
 * file still holds the deadline, and the session's next activation re-arms
 * it through `rehydrate()`, which is also what happens on Cloudflare once
 * the platform gives up on an alarm.
 *
 * Deliveries run concurrently across sessions up to a bound, so a host that
 * comes back after downtime opens overdue sessions a few at a time rather
 * than all at once; the next ones start as soon as one settles.
 */

import type { Logger } from "../logger";
import type { AlarmScheduleStore } from "../session/alarm/scheduler";
import type { ClaimedDeadline, HostAlarmIndex } from "./host-alarm-index";

/** The longest delay a single timer can hold; farther deadlines re-arm. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
/** First retry delay after a failed delivery; doubles per retry, as on the platform. */
export const RETRY_BASE_DELAY_MS = 2_000;
/** Retries before the host stops retrying on its own, as on the platform. */
export const MAX_RETRIES = 6;
/** Sessions delivered to at the same time, unless the host says otherwise. */
const DEFAULT_MAX_CONCURRENT_DELIVERIES = 8;
/** The clock source, unless a test supplies one; read per call so fake timers apply. */
const DEFAULT_NOW = (): number => Date.now();

export interface HostAlarmClockOptions {
  index: HostAlarmIndex;
  /**
   * Run the session's scheduled-deadline handler, opening the session
   * first if the host had evicted it.
   */
  deliver: (sessionId: string) => Promise<void>;
  log: Logger;
  now?: () => number;
  /** How many sessions may be delivered to at once. */
  maxConcurrentDeliveries?: number;
}

export class HostAlarmClock {
  private readonly index: HostAlarmIndex;
  private readonly deliver: (sessionId: string) => Promise<void>;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly maxConcurrentDeliveries: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(options: HostAlarmClockOptions) {
    this.index = options.index;
    this.deliver = options.deliver;
    this.log = options.log;
    this.now = options.now ?? DEFAULT_NOW;
    this.maxConcurrentDeliveries =
      options.maxConcurrentDeliveries ?? DEFAULT_MAX_CONCURRENT_DELIVERIES;
  }

  /** The alarm port for one session runtime. */
  storeFor(sessionId: string): AlarmScheduleStore {
    return {
      getAlarm: async () => this.index.get(sessionId),
      setAlarm: async (timestamp) => {
        this.index.set(sessionId, timestamp);
        this.arm();
      },
      deleteAlarm: async () => {
        this.index.delete(sessionId);
        this.arm();
      },
    };
  }

  /**
   * Arm for whatever the index holds. Claims a previous process left in
   * flight are delivered again: their handlers may not have run.
   */
  start(): void {
    this.running = true;
    const recovered = this.index.recoverClaims();
    if (recovered.length > 0) {
      this.log.warn("Re-arming deadlines a previous process left in flight", {
        event: "alarm.claims_recovered",
        session_ids: recovered,
      });
    }
    this.arm();
  }

  /** Stop firing. Deliveries already running are not interrupted. */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Resolves once every delivery that was running has settled. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight.values()]);
  }

  private arm(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.running) return;
    // At capacity, the settling delivery re-arms the clock. A session being
    // delivered to is left out: its next deadline is picked up the same way.
    if (this.inFlight.size >= this.maxConcurrentDeliveries) return;
    const next = this.index.earliest(this.inFlight.keys());
    if (next === null) return;
    const delay = Math.min(Math.max(0, next.deadline - this.now()), MAX_TIMER_DELAY_MS);
    this.timer = setTimeout(() => this.tick(), delay);
  }

  private tick(): void {
    this.timer = null;
    const capacity = this.maxConcurrentDeliveries - this.inFlight.size;
    if (capacity <= 0) return;
    for (const { sessionId } of this.index.due(this.now(), this.inFlight.keys(), capacity)) {
      const claimed = this.index.claim(sessionId);
      if (claimed === null) continue;
      // Registered before the handler starts, so a deadline it arms at once
      // is excluded from the next wake-up until this delivery settles.
      const delivery = Promise.resolve()
        .then(() => this.deliverTo(sessionId, claimed))
        .finally(() => {
          this.inFlight.delete(sessionId);
          this.arm();
        });
      this.inFlight.set(sessionId, delivery);
    }
    this.arm();
  }

  private async deliverTo(sessionId: string, claimed: ClaimedDeadline): Promise<void> {
    try {
      await this.deliver(sessionId);
      this.index.complete(sessionId);
    } catch (error) {
      const retry = claimed.failures < MAX_RETRIES;
      this.log.error("Scheduled deadline delivery failed", {
        event: "alarm.delivery_failed",
        session_id: sessionId,
        deadline: claimed.deadline,
        attempt: claimed.failures + 1,
        will_retry: retry,
        error_message: error instanceof Error ? error.message : String(error),
      });
      if (!retry) {
        // The session file keeps the deadline; its next activation re-arms it.
        this.index.complete(sessionId);
        return;
      }
      // Sooner than a replacement the handler armed, never later than it.
      this.index.retry(sessionId, this.now() + RETRY_BASE_DELAY_MS * 2 ** claimed.failures);
    }
  }
}
