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
 *
 * Every claim is a lease, held by the delivery that took it. Settling names
 * that token, so a claim recovered from a process that is gone cannot be
 * settled by a delivery that outlived it, and starting twice never takes a
 * claim away from a delivery still running here.
 *
 * When a lease runs out in a live process the clock stops counting that
 * delivery against the concurrency bound, so one handler that never returns
 * cannot narrow the clock for every other session. It does *not* redeliver
 * that session. The promise cannot be cancelled, the registry's leases count
 * rather than exclude, and the session's own alarm state carries no claim
 * token — so a second delivery would run into the same runtime beside the
 * first, and the stale one could clear a deadline the new one owns. Until
 * that fence reaches the session core, the abandoned session stays excluded
 * and its claim stays on disk, for the next start to recover.
 *
 * Polling, delivery and arming are total: an index that throws is logged and
 * the timer re-armed — behind a backoff, so a failure that persists is not a
 * spin — never left as an unhandled rejection from a timer task.
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
/**
 * How long a claim holds a session before it may be delivered again. Long
 * enough that a slow handler is never overtaken — opening an evicted session
 * and running its handler is bounded by the session's own work, not by this —
 * while a host that died or a handler that hung frees the session within the
 * quarter hour.
 */
export const ALARM_CLAIM_LEASE_MS = 15 * 60 * 1000;
/** How long the clock waits before trying again when the index cannot be read. */
export const BLIND_RETRY_INTERVAL_MS = 60 * 1000;
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
  /**
   * Deliveries this process started, by session id, with the claim each
   * holds. An entry past its lease is `abandoned`: it no longer counts
   * against the bound, but the session stays excluded while the promise it
   * cannot cancel is still running.
   */
  private readonly inFlight = new Map<
    string,
    { delivery: Promise<void>; token: string; leaseUntil: number; abandoned: boolean }
  >();

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
   * Arm for whatever the index holds. A claim on disk that no delivery here
   * owns was left by a process that is gone, and is armed again at once: its
   * handler may not have run. Idempotent, because the claims this process is
   * still delivering are named and left alone.
   */
  start(): void {
    this.running = true;
    const owned = [...this.inFlight.values()].map((entry) => entry.token);
    const recovered = this.index.recoverForeignClaims(owned);
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

  /**
   * Resolves once every delivery still counted has settled. A delivery whose
   * lease ran out is not among them: the clock has already let go of it.
   */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight.values()].map((entry) => entry.delivery));
  }

  /**
   * Wake at the soonest of: the next armed deadline, and the moment the
   * soonest claim's lease runs out. Both come from the index, so a claim
   * whose delivery this process has already let go of is still woken for.
   * With neither, there is nothing to wake for and no timer is set. At
   * capacity only the lease matters — a settling delivery re-arms for the
   * rest, and expired leases still have to be reclaimed meanwhile.
   */
  private arm(notBefore?: number): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.running) return;
    const now = this.now();
    let wakeAt: number | null = notBefore ?? null;
    try {
      const lease = this.index.earliestLease();
      if (lease !== null) wakeAt = Math.max(lease, notBefore ?? lease);
      // A session being delivered to is left out: its next deadline is
      // picked up when this delivery settles.
      if (this.liveDeliveries() < this.maxConcurrentDeliveries) {
        const next = this.index.earliest(this.inFlight.keys());
        if (next !== null) {
          const deadline = Math.max(next.deadline, notBefore ?? next.deadline);
          wakeAt = Math.min(wakeAt ?? deadline, deadline);
        }
      }
    } catch (error) {
      // Arming ends every path — setting a deadline, a tick, a settling
      // delivery — so a throw here would escape a timer task and take the
      // process with it. Waking blind keeps the clock alive until the index
      // can say what is due again.
      this.log.error("Alarm clock could not schedule its next wake-up", {
        event: "alarm.arm_failed",
        error_message: message(error),
      });
      wakeAt = now + BLIND_RETRY_INTERVAL_MS;
    }
    if (wakeAt === null) return;
    const delay = Math.min(Math.max(0, wakeAt - now), MAX_TIMER_DELAY_MS);
    this.timer = setTimeout(() => this.tick(), delay);
  }

  /** One wake-up. Total: nothing here may reject out of the timer task. */
  private tick(): void {
    this.timer = null;
    try {
      this.abandonExpiredDeliveries();
      this.claimAndDeliver();
    } catch (error) {
      // The index is unusable for now. Back off before waking again: the
      // deadline that could not be claimed is still overdue, so arming for it
      // would schedule another zero-delay tick and spin.
      this.log.error("Alarm clock failed to claim work", {
        event: "alarm.poll_failed",
        error_message: message(error),
      });
      this.arm(this.now() + BLIND_RETRY_INTERVAL_MS);
      return;
    }
    this.arm();
  }

  /**
   * Stop counting deliveries whose lease has run out against the bound, so
   * one handler that never returns does not narrow the clock for every other
   * session. The entry stays: the promise cannot be cancelled, and this
   * session must not be delivered to again while it runs.
   */
  private abandonExpiredDeliveries(): void {
    const now = this.now();
    const abandoned: string[] = [];
    for (const [sessionId, entry] of this.inFlight) {
      if (entry.abandoned || entry.leaseUntil > now) continue;
      entry.abandoned = true;
      abandoned.push(sessionId);
    }
    if (abandoned.length === 0) return;
    this.log.error("Deadline deliveries outlived their lease and stopped counting", {
      event: "alarm.delivery_abandoned",
      session_ids: abandoned,
    });
  }

  /** Deliveries still counted against the bound; an abandoned one is not. */
  private liveDeliveries(): number {
    let live = 0;
    for (const entry of this.inFlight.values()) if (!entry.abandoned) live += 1;
    return live;
  }

  private claimAndDeliver(): void {
    const capacity = this.maxConcurrentDeliveries - this.liveDeliveries();
    if (capacity <= 0) return;
    const leaseUntil = this.now() + ALARM_CLAIM_LEASE_MS;
    for (const { sessionId } of this.index.due(this.now(), this.inFlight.keys(), capacity)) {
      const claimed = this.index.claim(sessionId, leaseUntil);
      if (claimed === null) continue;
      // Registered before the handler starts, so a deadline it arms at once
      // is excluded from the next wake-up until this delivery settles.
      const delivery = Promise.resolve()
        .then(() => this.deliverTo(sessionId, claimed))
        .catch((error: unknown) => {
          // Settling failed, so the claim still stands; it comes back when
          // the lease runs out rather than being lost here.
          this.log.error("Deadline delivery could not be settled", {
            event: "alarm.settle_failed",
            session_id: sessionId,
            error_message: message(error),
          });
        })
        .finally(() => {
          // Only if this delivery is still the one being counted: an
          // abandoned delivery must not evict the one that replaced it.
          if (this.inFlight.get(sessionId)?.delivery === delivery) this.inFlight.delete(sessionId);
          this.arm();
        });
      this.inFlight.set(sessionId, {
        delivery,
        token: claimed.token,
        leaseUntil,
        abandoned: false,
      });
    }
  }

  private async deliverTo(sessionId: string, claimed: ClaimedDeadline): Promise<void> {
    // Only a recovered claim can arrive over budget: the settlement below
    // stops retrying a deadline that spent its last attempt, so the normal
    // path never hands one back.
    if (claimed.failures > MAX_RETRIES) {
      this.index.complete(sessionId, claimed.token);
      return;
    }
    try {
      await this.deliver(sessionId);
      this.index.complete(sessionId, claimed.token);
    } catch (error) {
      const retry = claimed.failures < MAX_RETRIES;
      this.log.error("Scheduled deadline delivery failed", {
        event: "alarm.delivery_failed",
        session_id: sessionId,
        deadline: claimed.deadline,
        attempt: claimed.failures + 1,
        will_retry: retry,
        error_message: message(error),
      });
      if (!retry) {
        // The session file keeps the deadline; its next activation re-arms it.
        this.index.complete(sessionId, claimed.token);
        return;
      }
      // Sooner than a replacement the handler armed, never later than it.
      this.index.retry(
        sessionId,
        claimed.token,
        this.now() + RETRY_BASE_DELAY_MS * 2 ** claimed.failures
      );
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
