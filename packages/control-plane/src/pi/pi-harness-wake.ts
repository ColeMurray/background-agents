/**
 * Serverless-safe wake discipline for the Pi Durable harness.
 *
 * Upstream `@earendil-works/pi-durable` on its `main` branch adds a host
 * contract for serverless hosts: `Harness.open(..., { onWake })`, `harness.wake()`
 * returning `{ active, at }`, and `harness.resume()` to restart the scheduler.
 * The published `1.3.0` release exposes only `resume()`.
 *
 * This module implements the same contract against the published release so
 * Pi Durable sessions behave correctly under Durable Object hibernation and
 * eviction today. When a release ships `onWake`/`wake()`, this file is the
 * only place that changes: the native wake replaces the derived one.
 */

/** Upstream-compatible wake description. */
export interface PiHarnessWake {
  /** Whether the harness can run work right now. */
  readonly active: boolean;
  /** Earliest timestamp the harness wants to be woken, if it is waiting. */
  readonly at?: number;
}

/** The subset of the Pi Durable harness this module drives. */
export interface ResumablePiHarness {
  resume(): void;
  /** Present only on releases that expose the native wake contract. */
  wake?(): PiHarnessWake;
}

export interface PiHarnessWakeControllerOptions {
  /** The harness the controller resumes. */
  readonly harness: ResumablePiHarness;
  /** Reports whether any operation can still run in this session. */
  readonly hasPendingWork: () => Promise<boolean>;
  /** Reports the earliest durable deadline this host must wake for. */
  readonly nextDeadline: () => Promise<number | null>;
}

/**
 * Drives the Pi harness on a serverless host.
 *
 * The controller never holds a timer of its own: a Durable Object may
 * hibernate at any time, so the host arms an alarm and wakes the object
 * instead.
 */
export class PiHarnessWakeController {
  private resumeCount = 0;

  constructor(private readonly options: PiHarnessWakeControllerOptions) {}

  /**
   * Restart the harness scheduler.
   *
   * Pi Durable keeps interrupted work pending; `resume()` continues it. It is
   * idempotent, so the controller may call it defensively.
   */
  resume(): void {
    this.resumeCount += 1;
    this.options.harness.resume();
  }

  /** Number of times the controller resumed the harness. */
  get resumes(): number {
    return this.resumeCount;
  }

  /**
   * Describe when the host must wake this object.
   *
   * A release with the native contract answers this exactly. Until then the
   * controller derives it from the host's own durable state, which is
   * conservative: an object that wakes early does nothing but re-check.
   */
  async wake(): Promise<PiHarnessWake> {
    const native = this.options.harness.wake?.();
    if (native) return native;
    const [pending, deadline] = await Promise.all([
      this.options.hasPendingWork(),
      this.options.nextDeadline(),
    ]);
    if (pending) return { active: true };
    return deadline === null ? { active: false } : { active: false, at: deadline };
  }

  /**
   * Whether the installed harness exposes the native wake contract.
   *
   * The deployment records this so an operator can see whether the host is
   * driving a native wake or the derived one.
   */
  get nativeWakeSupported(): boolean {
    return typeof this.options.harness.wake === "function";
  }
}
