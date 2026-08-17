import type { AlarmScheduler } from "../../platform-ports";
import type { SqlStorage } from "../sql-storage";

/** Storage-independent access to the runtime's single scheduled wake-up. */
export interface AlarmScheduleStore {
  getAlarm(): Promise<number | null>;
  setAlarm(timestamp: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface AlarmDeadlineStore {
  current(): number | null;
  set(deadline: number): void;
  clear(): void;
  clearIf(deadline: number): void;
}

export class PersistedAlarmDeadlineStore implements AlarmDeadlineStore {
  constructor(private readonly sql: SqlStorage) {}

  current(): number | null {
    const rows = this.sql
      .exec("SELECT deadline FROM session_alarm_deadline WHERE singleton = 1")
      .toArray() as Array<{ deadline: number }>;
    return rows[0]?.deadline ?? null;
  }

  set(deadline: number): void {
    this.sql.exec(
      `INSERT INTO session_alarm_deadline (singleton, deadline) VALUES (1, ?)
       ON CONFLICT(singleton) DO UPDATE SET deadline = excluded.deadline`,
      deadline
    );
  }

  clear(): void {
    this.sql.exec("DELETE FROM session_alarm_deadline WHERE singleton = 1");
  }

  clearIf(deadline: number): void {
    this.sql.exec(
      "DELETE FROM session_alarm_deadline WHERE singleton = 1 AND deadline = ?",
      deadline
    );
  }
}

/**
 * Coordinate callers that share a runtime's single alarm slot.
 *
 * Every alarm handler evaluates all due work, so retaining the earliest
 * deadline prevents one subsystem from delaying another. While an alarm
 * handler is running, the store may return null until a new alarm is set,
 * which lets the handler establish the next deadline normally.
 */
export function createEarliestAlarmScheduler(
  storage: AlarmScheduleStore,
  deadlines: AlarmDeadlineStore
): AlarmScheduler {
  let scheduling = Promise.resolve();

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = scheduling.then(operation);
    scheduling = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };

  return {
    schedule(timestamp: number): Promise<void> {
      return serialize(async () => {
        const currentAlarm = await storage.getAlarm();
        if (currentAlarm === null || timestamp < currentAlarm) {
          await storage.setAlarm(timestamp);
          deadlines.set(timestamp);
        } else {
          deadlines.set(currentAlarm);
        }
      });
    },
    cancel(): Promise<void> {
      return serialize(async () => {
        await storage.deleteAlarm();
        deadlines.clear();
      });
    },
    current(): Promise<number | null> {
      return serialize(() => storage.getAlarm());
    },
  };
}

/** Restore a persisted deadline into a newly adopted runtime. */
export async function rehydrateAlarmScheduler(
  scheduler: AlarmScheduler,
  deadlines: AlarmDeadlineStore
): Promise<void> {
  const deadline = deadlines.current();
  if (deadline !== null) await scheduler.schedule(deadline);
}

/** Clear a delivered deadline only after successful handling and only if it was not replaced. */
export async function handleAlarmDelivery(
  deadlines: AlarmDeadlineStore,
  handle: () => Promise<void>
): Promise<void> {
  const delivered = deadlines.current();
  await handle();
  if (delivered !== null) deadlines.clearIf(delivered);
}
