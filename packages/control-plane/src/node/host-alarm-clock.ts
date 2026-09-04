/**
 * The Node host's alarm: one timer for the whole process, armed for the
 * soonest deadline in the host alarm index, delivering to each session
 * through the host's `deliver` callback (which opens the session if it was
 * evicted and runs its scheduled-deadline handler).
 *
 * `storeFor(sessionId)` is the per-session `AlarmScheduleStore` the session
 * runtime is built over: what a Durable Object's `ctx.storage` alarm methods
 * provide. Setting a deadline records it in the index and re-arms the
 * timer; firing consumes the record before the handler runs, as the
 * platform clears a Durable Object's alarm when it fires, so a handler that
 * arms a new deadline replaces nothing. Delivery failures are retried with
 * backoff a bounded number of times, matching the platform.
 */

import type { Logger } from "../logger";
import type { AlarmScheduleStore } from "../session/alarm/scheduler";
import type { HostAlarmIndex } from "./host-alarm-index";

/** The longest delay a single timer can hold; farther deadlines re-arm. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
/** First retry delay after a failed delivery; doubles per attempt. */
const RETRY_BASE_DELAY_MS = 30_000;
/** Retries before a deadline is dropped, as the platform does. */
const MAX_DELIVERY_ATTEMPTS = 6;

export interface HostAlarmClockOptions {
  index: HostAlarmIndex;
  /**
   * Run the session's scheduled-deadline handler, opening the session
   * first if the host had evicted it.
   */
  deliver: (sessionId: string) => Promise<void>;
  log: Logger;
  now?: () => number;
}

export class HostAlarmClock {
  private readonly index: HostAlarmIndex;
  private readonly deliver: (sessionId: string) => Promise<void>;
  private readonly log: Logger;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, number>();

  constructor(options: HostAlarmClockOptions) {
    this.index = options.index;
    this.deliver = options.deliver;
    this.log = options.log;
    this.now = options.now ?? Date.now;
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

  /** Arm for whatever the index holds; a restart resumes from the file. */
  start(): void {
    this.running = true;
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
    const next = this.index.earliest();
    if (next === null) return;
    const delay = Math.min(Math.max(0, next.deadline - this.now()), MAX_TIMER_DELAY_MS);
    this.timer = setTimeout(() => this.tick(), delay);
  }

  private tick(): void {
    this.timer = null;
    for (const { sessionId, deadline } of this.index.due(this.now())) {
      // A session already being delivered keeps its new record until the
      // running delivery settles and the clock re-arms.
      if (this.inFlight.has(sessionId)) continue;
      this.index.delete(sessionId);
      const delivery = this.deliverTo(sessionId, deadline).finally(() => {
        this.inFlight.delete(sessionId);
        this.arm();
      });
      this.inFlight.set(sessionId, delivery);
    }
    this.arm();
  }

  private async deliverTo(sessionId: string, deadline: number): Promise<void> {
    try {
      await this.deliver(sessionId);
      this.failures.delete(sessionId);
    } catch (error) {
      const attempt = (this.failures.get(sessionId) ?? 0) + 1;
      const retry = attempt < MAX_DELIVERY_ATTEMPTS;
      this.log.error("Scheduled deadline delivery failed", {
        event: "alarm.delivery_failed",
        session_id: sessionId,
        deadline,
        attempt,
        will_retry: retry,
        error_message: error instanceof Error ? error.message : String(error),
      });
      if (!retry) {
        this.failures.delete(sessionId);
        return;
      }
      this.failures.set(sessionId, attempt);
      // The handler may have armed a new deadline; a retry never delays it.
      if (this.index.get(sessionId) === null) {
        this.index.set(sessionId, this.now() + RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  }
}
