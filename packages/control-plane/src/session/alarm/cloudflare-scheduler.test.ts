import { describe, expect, it, vi } from "vitest";
import { createCloudflareAlarmScheduler } from "./cloudflare-scheduler";

describe("createCloudflareAlarmScheduler", () => {
  it("coalesces deadlines through Durable Object alarm storage", async () => {
    const storage = {
      getAlarm: vi.fn(async () => 3_000),
      setAlarm: vi.fn(async (_timestamp: number) => {}),
    };
    const scheduler = createCloudflareAlarmScheduler(storage);

    await scheduler.scheduleAlarm(2_000);

    expect(storage.getAlarm).toHaveBeenCalledOnce();
    expect(storage.setAlarm).toHaveBeenCalledWith(2_000);
  });

  it("shares deadline coordination across adapters for the same storage", async () => {
    let currentAlarm: number | null = null;
    let releaseFirstRead!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    const storage = {
      getAlarm: vi
        .fn<() => Promise<number | null>>()
        .mockImplementationOnce(async () => {
          await firstRead;
          return currentAlarm;
        })
        .mockImplementation(async () => currentAlarm),
      setAlarm: vi.fn(async (timestamp: number) => {
        currentAlarm = timestamp;
      }),
    };
    const firstScheduler = createCloudflareAlarmScheduler(storage);
    const secondScheduler = createCloudflareAlarmScheduler(storage);

    const earlier = firstScheduler.scheduleAlarm(2_000);
    const later = secondScheduler.scheduleAlarm(3_000);
    releaseFirstRead();
    await Promise.all([earlier, later]);

    expect(currentAlarm).toBe(2_000);
    expect(storage.setAlarm).toHaveBeenCalledOnce();
  });
});
