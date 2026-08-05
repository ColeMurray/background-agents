import type { AlarmScheduler } from "../../sandbox/lifecycle/manager";

type AlarmStorage = Pick<DurableObjectStorage, "getAlarm" | "setAlarm">;

/**
 * Coordinate callers that share a Durable Object's single alarm slot.
 *
 * Every alarm handler evaluates all due work, so retaining the earliest
 * deadline prevents one subsystem from delaying another. While an alarm
 * handler is running, Cloudflare returns null until a new alarm is set, which
 * lets the handler establish the next deadline normally.
 */
export function createEarliestAlarmScheduler(storage: AlarmStorage): AlarmScheduler {
  return {
    async scheduleAlarm(timestamp: number): Promise<void> {
      const currentAlarm = await storage.getAlarm();
      if (currentAlarm === null || timestamp < currentAlarm) {
        await storage.setAlarm(timestamp);
      }
    },
  };
}
