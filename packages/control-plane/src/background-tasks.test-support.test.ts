import { describe, it, expect } from "vitest";
import { createTestBackgroundTasks } from "./background-tasks.test-support";

// Pins the adapter to the production submit contract; see
// cloudflare/background-tasks.test.ts for the implementation's own suite.
describe("createTestBackgroundTasks", () => {
  it("absorbs a synchronous factory throw and records it", () => {
    const background = createTestBackgroundTasks();
    const boom = new Error("sync boom");

    expect(() =>
      background.submit(
        () => {
          throw boom;
        },
        { name: "test.sync_throw" }
      )
    ).not.toThrow();

    expect(background.failures).toEqual([boom]);
    expect(background.submissions).toEqual([{ name: "test.sync_throw" }]);
  });

  it("runs the factory synchronously and records the task in order", async () => {
    const background = createTestBackgroundTasks();
    let ran = false;

    background.submit(
      async () => {
        ran = true;
      },
      { name: "test.task" }
    );

    expect(ran).toBe(true);
    expect(background.submissions).toHaveLength(1);
    await background.settle();
  });

  it("absorbs rejections into failures so unawaited tasks cannot fail a run", async () => {
    const background = createTestBackgroundTasks();

    background.submit(() => Promise.reject(new Error("late boom")), { name: "test.reject" });

    await expect(background.settle()).resolves.toBeUndefined();
    expect(background.failures).toEqual([expect.objectContaining({ message: "late boom" })]);
    await expect(background.submissions[0]?.task).rejects.toThrow("late boom");
  });
});
