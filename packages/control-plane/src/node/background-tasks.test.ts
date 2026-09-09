import { describe, expect, it, vi } from "vitest";
import { createNodeBackgroundTasks } from "./background-tasks";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function testLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
}

describe("createNodeBackgroundTasks", () => {
  it("runs the factory synchronously and tracks the task until it settles", async () => {
    const tasks = createNodeBackgroundTasks(testLogger() as never);
    const work = deferred();
    const runs: number[] = [];

    tasks.submit(
      () => {
        runs.push(runs.length + 1);
        return work.promise;
      },
      { name: "test.task" }
    );

    expect(runs).toEqual([1]);
    expect(tasks.size).toBe(1);
    work.resolve();
    await flush();
    expect(tasks.size).toBe(0);
  });

  it("logs a rejected task and stops tracking it without rethrowing", async () => {
    const log = testLogger();
    const tasks = createNodeBackgroundTasks(log as never);

    tasks.submit(() => Promise.reject(new Error("task failed")), {
      name: "test.task",
      context: { session_id: "session-1" },
    });
    await flush();

    expect(tasks.size).toBe(0);
    expect(log.error).toHaveBeenCalledWith("background_task.failed", {
      task_name: "test.task",
      session_id: "session-1",
      error: expect.objectContaining({ message: "task failed" }),
    });
  });

  it("absorbs and logs a factory that throws synchronously", () => {
    const log = testLogger();
    const tasks = createNodeBackgroundTasks(log as never);

    expect(() =>
      tasks.submit(
        () => {
          throw new Error("construction failed");
        },
        { name: "test.task", context: { session_id: "session-1" } }
      )
    ).not.toThrow();

    // Nothing started, so there is nothing to track.
    expect(tasks.size).toBe(0);
    expect(log.error).toHaveBeenCalledWith("background_task.failed", {
      task_name: "test.task",
      session_id: "session-1",
      error: expect.objectContaining({ message: "construction failed" }),
    });
  });

  it("drain waits for running tasks, including ones submitted meanwhile", async () => {
    const log = testLogger();
    const tasks = createNodeBackgroundTasks(log as never);
    const first = deferred();
    const second = deferred();
    tasks.submit(() => first.promise, { name: "first" });

    const drained = tasks.drain(5_000);
    let settled = false;
    void drained.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    // A task started while draining is waited for too.
    tasks.submit(() => second.promise, { name: "second" });
    first.resolve();
    await flush();
    expect(settled).toBe(false);

    second.resolve();
    expect(await drained).toBe(0);
    expect(tasks.size).toBe(0);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("drain gives up at the deadline and reports the stragglers by name", async () => {
    const log = testLogger();
    const tasks = createNodeBackgroundTasks(log as never);
    const never = deferred();
    tasks.submit(() => never.promise, { name: "stuck.task" });
    tasks.submit(() => Promise.resolve(), { name: "quick.task" });

    expect(await tasks.drain(20)).toBe(1);

    expect(log.warn).toHaveBeenCalledWith("background_task.drain_timeout", {
      timeout_ms: 20,
      pending: 1,
      task_names: ["stuck.task"],
    });
    // The straggler keeps running; draining does not cancel it.
    expect(tasks.size).toBe(1);
    never.resolve();
    await flush();
    expect(tasks.size).toBe(0);
  });

  it("drain returns at once when nothing is running", async () => {
    const tasks = createNodeBackgroundTasks(testLogger() as never);
    expect(await tasks.drain(1)).toBe(0);
  });
});
