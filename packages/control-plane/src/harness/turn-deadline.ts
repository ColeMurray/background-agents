/**
 * The turn's deadline, inside the Durable Object.
 *
 * A sandbox harness is bounded by the platform: the sandbox dies, the run is
 * reaped, the message fails. A Durable Object harness is not bounded by
 * anything but itself, so a turn that never finishes — a model that keeps
 * calling a tool, a tool that never returns — would hold the object, its
 * storage, and the session's money for as long as it liked.
 *
 * So the turn has a deadline, and the deadline is **inside** the object: the
 * harness is asked to stop, and the stop is recorded as the turn's own
 * outcome. Waiting for the session's recovery sweep would be too late: the
 * sweep exists to catch a lost callback, and reaping a live run is far worse
 * than reaping a dead one late.
 *
 * The deadline is the session's own execution budget plus the grace the
 * recovery sweep gets (`EXECUTION_DEADLINE_GRACE_MS`), so the in-object stop
 * and the session's sweep never disagree about when a turn is late.
 *
 * The contract is harness-neutral: it names a deadline, not a model, and it
 * works for any runtime that can arm a timer.
 */

/** A timer the deadline can arm. */
export interface HarnessTurnDeadlineTimers {
  /** Arm a timer. Returns a handle the deadline can cancel. */
  set(handler: () => void, delayMs: number): unknown;
  /** Cancel a timer. */
  clear(handle: unknown): void;
}

/** An armed deadline. */
export interface HarnessTurnDeadline {
  /** Whether the deadline has passed. */
  readonly expired: boolean;
  /** How long is left, in milliseconds. Never negative. */
  readonly remainingMs: number;
  /** Cancel the deadline: the turn finished before it was late. */
  clear(): void;
}

export interface ArmTurnDeadlineOptions {
  /** When the turn is late. Absolute, in milliseconds since the epoch. */
  readonly deadlineMs: number;
  /** What happens when the deadline passes. */
  readonly onExpire: () => void | Promise<void>;
  /** The clock. */
  readonly now?: () => number;
  /** The timers. */
  readonly timers?: HarnessTurnDeadlineTimers;
}

/**
 * Arm a turn's deadline.
 *
 * A deadline that has already passed expires at once: a turn that is handed
 * a deadline in the past is late, and the harness is told so immediately
 * rather than being allowed to start.
 */
export function armTurnDeadline(options: ArmTurnDeadlineOptions): HarnessTurnDeadline {
  const now = options.now ?? Date.now;
  const timers =
    options.timers ??
    ({
      set: (handler: () => void, delayMs: number) => setTimeout(handler, delayMs),
      clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    } satisfies HarnessTurnDeadlineTimers);

  let expired = false;
  let handle: unknown;
  let cleared = false;

  const expire = (): void => {
    if (expired || cleared) return;
    expired = true;
    void options.onExpire();
  };

  const remaining = options.deadlineMs - now();
  if (remaining <= 0) {
    // Late already: the turn does not get a chance to run.
    expire();
  } else {
    handle = timers.set(expire, remaining);
  }

  return {
    get expired(): boolean {
      return expired;
    },
    get remainingMs(): number {
      return Math.max(0, options.deadlineMs - now());
    },
    clear(): void {
      if (cleared) return;
      cleared = true;
      if (handle !== undefined) timers.clear(handle);
    },
  };
}
