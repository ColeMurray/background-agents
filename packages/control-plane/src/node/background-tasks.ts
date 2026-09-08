/**
 * The Node host's `BackgroundTasks`: a tracked set of running promises.
 *
 * On Cloudflare `submit` extends the event's lifetime with `waitUntil` and
 * the platform waits. A Node process has no event lifetime: a promise simply
 * runs. What the host needs instead is to know what is running, so a
 * session registry can tell whether a runtime is idle and a shutdown can
 * wait for the work before the process exits. One instance per session
 * runtime, plus one for the process-level routes.
 *
 * The boundary is the same as the Cloudflare adapter's: the factory runs
 * synchronously inside `submit`, a synchronous throw is absorbed and logged,
 * and a rejection is logged, never rethrown.
 */

import type { Logger } from "../logger";
import type { BackgroundTasks } from "../platform-ports";

export interface NodeBackgroundTasks extends BackgroundTasks {
  /** Tasks started and not yet settled. */
  readonly size: number;
  /**
   * Wait for every running task, including ones submitted meanwhile, for at
   * most `timeoutMs`. Tasks still running at the deadline are logged by
   * name and left running; returns how many there were.
   */
  drain(timeoutMs: number): Promise<number>;
}

export function createNodeBackgroundTasks(log: Logger): NodeBackgroundTasks {
  const running = new Map<Promise<unknown>, string>();
  return {
    get size() {
      return running.size;
    },
    submit(task, metadata): void {
      const logFailure = (error: unknown): void => {
        log.error("background_task.failed", {
          task_name: metadata.name,
          ...metadata.context,
          error: error instanceof Error ? error : String(error),
        });
      };
      let pending: Promise<unknown>;
      try {
        pending = task();
      } catch (error) {
        logFailure(error);
        return; // Nothing started, so there is nothing to track.
      }
      const tracked: Promise<unknown> = pending
        .catch(logFailure)
        .finally(() => running.delete(tracked));
      running.set(tracked, metadata.name);
    },
    async drain(timeoutMs: number): Promise<number> {
      const deadline = Date.now() + timeoutMs;
      while (running.size > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0 || !(await settlesWithin([...running.keys()], remaining))) break;
      }
      if (running.size > 0) {
        log.warn("background_task.drain_timeout", {
          timeout_ms: timeoutMs,
          pending: running.size,
          task_names: [...running.values()],
        });
      }
      return running.size;
    },
  };
}

/** Whether every promise in `tasks` settles within `ms`. */
export function settlesWithin(tasks: Promise<unknown>[], ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void Promise.allSettled(tasks).then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
