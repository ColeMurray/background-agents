import { describe, expect, it, vi } from "vitest";
import { createCloudflareBackgroundTasks } from "./background-tasks";

describe("createCloudflareBackgroundTasks", () => {
  it("extends the Durable Object lifetime for the spawned task", () => {
    const waitUntil = vi.fn();
    const background = createCloudflareBackgroundTasks({ waitUntil });
    const job = Promise.resolve();

    background.spawn(job);

    expect(waitUntil).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });

  it("catches and logs rejected tasks", async () => {
    const waitUntil = vi.fn();
    const logger = { error: vi.fn() };
    const background = createCloudflareBackgroundTasks({ waitUntil }, () => logger as never);

    background.spawn(Promise.reject(new Error("task failed")));
    await waitUntil.mock.calls[0]![0];

    expect(logger.error).toHaveBeenCalledWith("background_task.failed", {
      error: expect.objectContaining({ message: "task failed" }),
    });
  });
});
