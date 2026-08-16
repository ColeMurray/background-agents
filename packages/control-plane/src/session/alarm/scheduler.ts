import type { AlarmScheduler } from "../../platform-ports";

/** Storage-independent access to the runtime's single scheduled wake-up. */
export interface AlarmScheduleStore {
  getAlarm(): Promise<number | null>;
  setAlarm(timestamp: number): Promise<void>;
}

/**
 * Coordinate callers that share a runtime's single alarm slot.
 *
 * Every alarm handler evaluates all due work, so retaining the earliest
 * deadline prevents one subsystem from delaying another. While an alarm
 * handler is running, the store may return null until a new alarm is set,
 * which lets the handler establish the next deadline normally.
 */
export function createEarliestAlarmScheduler(storage: AlarmScheduleStore): AlarmScheduler {
  let scheduling = Promise.resolve();

  return {
    scheduleAlarm(timestamp: number): Promise<void> {
      const operation = scheduling.then(async () => {
        const currentAlarm = await storage.getAlarm();
        if (currentAlarm === null || timestamp < currentAlarm) {
          await storage.setAlarm(timestamp);
        }
      });
      scheduling = operation.catch(() => {});
      return operation;
    },
  };
}
