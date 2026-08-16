import type { AlarmScheduler } from "../../sandbox/lifecycle/manager";

/** Storage-independent access to the runtime's single scheduled wake-up. */
export interface AlarmScheduleStore {
  getAlarm(): Promise<number | null>;
  setAlarm(timestamp: number): Promise<void>;
}

const schedulingByStore = new WeakMap<AlarmScheduleStore, Promise<void>>();

/**
 * Coordinate callers that share a runtime's single alarm slot.
 *
 * Every alarm handler evaluates all due work, so retaining the earliest
 * deadline prevents one subsystem from delaying another. While an alarm
 * handler is running, the store may return null until a new alarm is set,
 * which lets the handler establish the next deadline normally.
 *
 * Scheduler instances over the same store object share in-process
 * serialization. Distributed runtimes must implement AlarmScheduler with an
 * atomic earliest-deadline write instead of using this helper across processes.
 */
export function createEarliestAlarmScheduler(storage: AlarmScheduleStore): AlarmScheduler {
  return {
    scheduleAlarm(timestamp: number): Promise<void> {
      const scheduling = schedulingByStore.get(storage) ?? Promise.resolve();
      const operation = scheduling.then(async () => {
        const currentAlarm = await storage.getAlarm();
        if (currentAlarm === null || timestamp < currentAlarm) {
          await storage.setAlarm(timestamp);
        }
      });
      schedulingByStore.set(
        storage,
        operation.catch(() => {})
      );
      return operation;
    },
  };
}
