import { describe, expect, it, vi } from "vitest";
import { createCloudflareBackgroundTasks } from "./background-tasks";

describe("createCloudflareBackgroundTasks", () => {
  it("extends the Durable Object lifetime for the spawned task", () => {
    const waitUntil = vi.fn();
    const background = createCloudflareBackgroundTasks({ waitUntil });

    background.submit(() => Promise.resolve(), { name: "test.task" });

    expect(waitUntil).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });

  it("runs the factory synchronously exactly once", () => {
    const waitUntil = vi.fn();
    const background = createCloudflareBackgroundTasks({ waitUntil });
    const runs: number[] = [];

    background.submit(
      () => {
        runs.push(runs.length + 1);
        return Promise.resolve();
      },
      { name: "test.task" }
    );

    // The side effect is observable before submit returns: the factory runs
    // synchronously, with no microtask deferral.
    expect(runs).toEqual([1]);
  });

  it("catches and logs rejected tasks", async () => {
    const waitUntil = vi.fn();
    const logger = { error: vi.fn() };
    const background = createCloudflareBackgroundTasks({ waitUntil }, logger as never);

    background.submit(() => Promise.reject(new Error("task failed")), {
      name: "test.task",
      context: { session_id: "session-1" },
    });
    await waitUntil.mock.calls[0]![0];

    expect(logger.error).toHaveBeenCalledWith("background_task.failed", {
      task_name: "test.task",
      session_id: "session-1",
      error: expect.objectContaining({ message: "task failed" }),
    });
  });

  it("absorbs and logs a factory that throws synchronously", () => {
    const waitUntil = vi.fn();
    const logger = { error: vi.fn() };
    const background = createCloudflareBackgroundTasks({ waitUntil }, logger as never);

    expect(() =>
      background.submit(
        () => {
          throw new Error("construction failed");
        },
        { name: "test.task", context: { session_id: "session-1" } }
      )
    ).not.toThrow();

    // Nothing started, so there is no lifetime to extend.
    expect(waitUntil).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith("background_task.failed", {
      task_name: "test.task",
      session_id: "session-1",
      error: expect.objectContaining({ message: "construction failed" }),
    });
  });
});
