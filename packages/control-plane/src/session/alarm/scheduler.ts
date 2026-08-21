import type { AlarmScheduler } from "../../platform-ports";
import type { SqlStorage } from "../sql-storage";

/** Storage-independent access to the runtime's single scheduled wake-up. */
export interface AlarmScheduleStore {
  getAlarm(): Promise<number | null>;
  setAlarm(timestamp: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface AlarmDeadlineStore {
  pending(): number | null;
  earliest(): number | null;
  cancelled(): boolean;
  setPending(deadline: number): void;
  activate(): void;
  clear(): void;
  beginDelivery(): number | "cancelled" | null;
  completeDelivery(): void;
}

interface AlarmStateRow {
  pending_deadline: number | null;
  in_flight_deadline: number | null;
  cancelled: number;
}

export class PersistedAlarmDeadlineStore implements AlarmDeadlineStore {
  constructor(private readonly sql: SqlStorage) {}

  pending(): number | null {
    return this.read()?.pending_deadline ?? null;
  }

  earliest(): number | null {
    const state = this.read();
    if (!state || state.cancelled === 1) return null;
    const deadlines = [state.pending_deadline, state.in_flight_deadline].filter(
      (deadline): deadline is number => deadline !== null
    );
    return deadlines.length > 0 ? Math.min(...deadlines) : null;
  }

  cancelled(): boolean {
    return this.read()?.cancelled === 1;
  }

  setPending(deadline: number): void {
    this.sql.exec(
      `INSERT INTO session_alarm_state (singleton, pending_deadline) VALUES (1, ?)
       ON CONFLICT(singleton) DO UPDATE SET pending_deadline = excluded.pending_deadline`,
      deadline
    );
  }

  activate(): void {
    this.sql.exec("UPDATE session_alarm_state SET cancelled = 0 WHERE singleton = 1");
  }

  clear(): void {
    this.sql.exec(`INSERT INTO session_alarm_state (singleton, cancelled) VALUES (1, 1)
      ON CONFLICT(singleton) DO UPDATE SET
        pending_deadline = NULL,
        in_flight_deadline = NULL,
        cancelled = 1`);
  }

  beginDelivery(): number | "cancelled" | null {
    const state = this.read();
    if (state?.cancelled === 1) return "cancelled";
    if (!state) return null;
    this.sql.exec(`UPDATE session_alarm_state
      SET in_flight_deadline = COALESCE(in_flight_deadline, pending_deadline),
          pending_deadline = CASE WHEN in_flight_deadline IS NULL THEN NULL ELSE pending_deadline END
      WHERE singleton = 1`);
    return this.read()?.in_flight_deadline ?? null;
  }

  completeDelivery(): void {
    this.sql.exec("UPDATE session_alarm_state SET in_flight_deadline = NULL WHERE singleton = 1");
  }

  private read(): AlarmStateRow | null {
    const rows = this.sql
      .exec(
        `SELECT pending_deadline, in_flight_deadline, cancelled
         FROM session_alarm_state WHERE singleton = 1`
      )
      .toArray() as AlarmStateRow[];
    return rows[0] ?? null;
  }
}

export interface RehydratableAlarmScheduler extends AlarmScheduler {
  rehydrate(): Promise<void>;
  rearmPending(): Promise<void>;
}

/**
 * Coordinate callers that share a runtime's single alarm slot.
 *
 * The persisted pending deadline is authoritative. Runtime mutations happen
 * only after persistence, so a failed runtime update can be retried on rehydration.
 */
export function createEarliestAlarmScheduler(
  storage: AlarmScheduleStore,
  deadlines: AlarmDeadlineStore
): RehydratableAlarmScheduler {
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
        const cancelled = deadlines.cancelled();
        const persisted = deadlines.pending();
        const next = persisted === null || timestamp < persisted ? timestamp : persisted;
        if (next !== persisted) deadlines.setPending(next);

        if (cancelled) {
          await storage.deleteAlarm();
          await storage.setAlarm(next);
          deadlines.activate();
          return;
        }

        const runtime = await storage.getAlarm();
        if (runtime === null || next < runtime) await storage.setAlarm(next);
      });
    },
    cancel(): Promise<void> {
      return serialize(async () => {
        deadlines.clear();
        await storage.deleteAlarm();
      });
    },
    current(): Promise<number | null> {
      return serialize(async () => deadlines.pending());
    },
    rehydrate(): Promise<void> {
      return serialize(async () => {
        const cancelled = deadlines.cancelled();
        const deadline = cancelled ? deadlines.pending() : deadlines.earliest();
        if (cancelled) {
          await storage.deleteAlarm();
          if (deadline !== null) await storage.setAlarm(deadline);
          deadlines.activate();
          return;
        }
        if (deadline === null) return;
        const runtime = await storage.getAlarm();
        if (runtime === null || deadline < runtime) await storage.setAlarm(deadline);
      });
    },
    rearmPending(): Promise<void> {
      return serialize(async () => {
        const pending = deadlines.pending();
        if (pending === null) return;
        const runtime = await storage.getAlarm();
        if (runtime === null || pending < runtime) await storage.setAlarm(pending);
      });
    },
  };
}

/** Track delivery separately so retries cannot acknowledge a replacement deadline. */
export async function handleAlarmDelivery(
  deadlines: AlarmDeadlineStore,
  handle: () => Promise<void>,
  rearm: () => Promise<void>
): Promise<void> {
  const delivered = deadlines.beginDelivery();
  if (delivered === "cancelled") return;
  await handle();
  if (delivered !== null) {
    await rearm();
    deadlines.completeDelivery();
  }
}
