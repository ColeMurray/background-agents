import { describe, expect, it, vi } from "vitest";
import type { SqlResult, SqlStorage } from "../sql-storage";
import { SessionAlarmCoordinator } from "./coordinator";

function harness() {
  const deadlines = new Map<string, number>();
  const sql: SqlStorage = {
    exec: vi.fn((query: string, ...params: unknown[]) => {
      if (query.includes("INSERT INTO session_alarm_deadlines")) {
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
    setAlarm: vi.fn(async () => {}),
    deleteAlarm: vi.fn(async () => {}),
  };
  return { coordinator: new SessionAlarmCoordinator(sql, storage), storage };
}

describe("SessionAlarmCoordinator", () => {
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
