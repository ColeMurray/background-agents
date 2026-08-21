import { describe, expect, it, vi } from "vitest";
import { createCloudflareBackgroundTasks } from "./background-tasks";

describe("createCloudflareBackgroundTasks", () => {
  it("extends the Durable Object lifetime for the spawned task", () => {
    const waitUntil = vi.fn();
    const background = createCloudflareBackgroundTasks({ waitUntil });
    const job = Promise.resolve();

    background.submit(job, { name: "test.task" });

    expect(waitUntil).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });

  it("catches and logs rejected tasks", async () => {
    const waitUntil = vi.fn();
    const logger = { error: vi.fn() };
    const background = createCloudflareBackgroundTasks({ waitUntil }, () => logger as never);

    background.submit(Promise.reject(new Error("task failed")), {
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
});
