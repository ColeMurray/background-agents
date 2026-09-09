import type { BackgroundTasks } from "./platform-ports";

/** One `submit` call: the task name and the factory's promise (absent when it threw). */
interface RecordedSubmission {
  name: string;
  task?: Promise<unknown>;
}

export interface TestBackgroundTasks extends BackgroundTasks {
  /** Every submit in order. Assert on `.length` instead of spying on `submit`. */
  readonly submissions: RecordedSubmission[];
  /**
   * Errors absorbed by the boundary — synchronous factory throws immediately,
   * rejections once the task settles — exactly the set production logs as
   * `background_task.failed`.
   */
  readonly failures: unknown[];
  /** Await every recorded task, tolerating rejections (production absorbs them). */
  settle(): Promise<void>;
}

/**
 * Contract-faithful `BackgroundTasks` double, mirroring
 * `createCloudflareBackgroundTasks`: the factory is invoked synchronously, a
 * synchronous throw is absorbed, and rejections are absorbed; both land in
 * `failures`. Tests drain deferred work via `settle()` (or an individual
 * `submissions[i].task`). Keep this behaviourally identical to the production
 * implementation — a fake with a different boundary makes collaborator tests
 * exercise a contract production does not have.
 */
export function createTestBackgroundTasks(): TestBackgroundTasks {
  const submissions: RecordedSubmission[] = [];
  const failures: unknown[] = [];
  return {
    submissions,
    failures,
    submit(task, metadata) {
      let pending: Promise<unknown>;
      try {
        pending = task();
      } catch (error) {
        failures.push(error);
        submissions.push({ name: metadata.name });
        return;
      }
      void pending.catch((error) => failures.push(error));
      submissions.push({ name: metadata.name, task: pending });
    },
    async settle() {
      for (const submission of submissions) {
        await submission.task?.catch(() => {});
      }
    },
  };
}
