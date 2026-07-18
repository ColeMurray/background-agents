import { describe, expect, it, vi } from "vitest";
import type { SqlResult, SqlStorage } from "../sql-storage";
import { SessionAlarmCoordinator } from "./coordinator";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function harness(legacyAlarm: number | null = null) {
  const deadlines = new Map<string, number>();
  const sql: SqlStorage = {
    exec: vi.fn((query: string, ...params: unknown[]) => {
      if (query.includes("INSERT") && query.includes("session_alarm_deadlines (name, deadline)")) {
        deadlines.set(params[0] as string, params[1] as number);
      } else if (query.includes("DELETE FROM session_alarm_deadlines WHERE name =")) {
        deadlines.delete(params[0] as string);
      } else if (query.includes("DELETE FROM session_alarm_deadlines WHERE deadline <=")) {
        for (const [name, deadline] of deadlines) {
          if (deadline <= (params[0] as number)) deadlines.delete(name);
        }
      }
      const rows = query.includes("MIN(deadline)")
        ? [{ deadline: deadlines.size ? Math.min(...deadlines.values()) : null }]
        : [];
      return {
        toArray: () => rows,
        one: () => rows[0],
        raw: () => [],
        columnNames: [],
        rowsRead: rows.length,
        rowsWritten: 0,
      } as unknown as SqlResult;
    }),
  };
  const storage = {
    getAlarm: vi.fn(async () => legacyAlarm),
    setAlarm: vi.fn(async () => {}),
    deleteAlarm: vi.fn(async () => {}),
  };
  return { coordinator: new SessionAlarmCoordinator(sql, storage), storage };
}

describe("SessionAlarmCoordinator", () => {
  it("adopts a legacy physical alarm before the first named deadline mutation", async () => {
    const { coordinator, storage } = harness(100);

    await coordinator.schedule("lifecycle", 500);

    expect(storage.getAlarm).toHaveBeenCalledTimes(1);
    expect(storage.setAlarm).toHaveBeenLastCalledWith(100);
  });

  it("clears an adopted legacy deadline when its alarm runs", async () => {
    const { coordinator, storage } = harness(100);

    await coordinator.run(100, []);

    expect(storage.getAlarm).toHaveBeenCalledTimes(1);
    expect(storage.deleteAlarm).toHaveBeenCalledTimes(1);
    expect(storage.setAlarm).not.toHaveBeenCalled();
  });

  it("keeps the earliest named deadline regardless of scheduling order", async () => {
    const first = harness();
    await first.coordinator.schedule("lifecycle", 500);
    await first.coordinator.schedule("diff_capture", 200);
    expect(first.storage.setAlarm).toHaveBeenLastCalledWith(200);

    const second = harness();
    await second.coordinator.schedule("diff_capture", 200);
    await second.coordinator.schedule("lifecycle", 500);
    expect(second.storage.setAlarm).toHaveBeenLastCalledWith(200);
  });

  it("serializes concurrent deadline mutations through alarm storage", async () => {
    const { coordinator, storage } = harness();
    const firstWrite = deferred();
    const secondWrite = deferred();
    storage.setAlarm
      .mockImplementationOnce(async () => firstWrite.promise)
      .mockImplementationOnce(async () => secondWrite.promise);

    const laterDeadline = coordinator.schedule("lifecycle", 500);
    await vi.waitFor(() => expect(storage.setAlarm).toHaveBeenCalledTimes(1));

    const earlierDeadline = coordinator.schedule("diff_capture", 200);
    await Promise.resolve();
    expect(storage.setAlarm).toHaveBeenCalledTimes(1);

    firstWrite.resolve();
    await vi.waitFor(() => expect(storage.setAlarm).toHaveBeenCalledTimes(2));
    secondWrite.resolve();
    await Promise.all([laterDeadline, earlierDeadline]);

    expect(storage.setAlarm.mock.calls).toEqual([[500], [200]]);
  });

  it("does not clear an alarm while a preceding schedule is still being written", async () => {
    const { coordinator, storage } = harness();
    const scheduleWrite = deferred();
    const clearWrite = deferred();
    storage.setAlarm.mockImplementationOnce(async () => scheduleWrite.promise);
    storage.deleteAlarm.mockImplementationOnce(async () => clearWrite.promise);

    const schedule = coordinator.schedule("lifecycle", 500);
    await vi.waitFor(() => expect(storage.setAlarm).toHaveBeenCalledTimes(1));

    const clear = coordinator.clear("lifecycle");
    await Promise.resolve();
    expect(storage.deleteAlarm).not.toHaveBeenCalled();

    scheduleWrite.resolve();
    await vi.waitFor(() => expect(storage.deleteAlarm).toHaveBeenCalledTimes(1));
    clearWrite.resolve();
    await Promise.all([schedule, clear]);
  });

  it("restores the next concern when an earlier deadline is cleared", async () => {
    const { coordinator, storage } = harness();
    await coordinator.schedule("lifecycle", 500);
    await coordinator.schedule("diff_cleanup", 200);

    await coordinator.clear("diff_cleanup");

    expect(storage.setAlarm).toHaveBeenLastCalledWith(500);
  });

  it("runs alarm tasks in order, isolates failures, and still rearms", async () => {
    const { coordinator, storage } = harness();
    await coordinator.schedule("diff_capture", 100);
    await coordinator.schedule("lifecycle", 500);
    const order: string[] = [];

    await expect(
      coordinator.run(100, [
        {
          name: "diff",
          run: async () => {
            order.push("diff");
            throw new Error("capture cleanup failed");
          },
        },
        {
          name: "execution",
          run: async () => {
            order.push("execution");
          },
        },
        {
          name: "lifecycle",
          run: async () => {
            order.push("lifecycle");
          },
        },
      ])
    ).rejects.toThrow("capture cleanup failed");

    expect(order).toEqual(["diff", "execution", "lifecycle"]);
    expect(storage.setAlarm).toHaveBeenLastCalledWith(500);
  });
});
