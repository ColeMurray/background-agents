import type { SqlStorage } from "../sql-storage";

export type SessionAlarmConcern = "lifecycle" | "execution" | "diff_capture" | "diff_cleanup";

interface AlarmStorage {
  setAlarm(timestamp: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface SessionAlarmTask {
  name: string;
  run: () => Promise<void>;
}

/** Persists independent deadlines and maps their minimum to the one DO alarm. */
export class SessionAlarmCoordinator {
  private alarmOperation: Promise<void> = Promise.resolve();

  constructor(
    private readonly sql: SqlStorage,
    private readonly storage: AlarmStorage
  ) {}

  async schedule(concern: SessionAlarmConcern, deadline: number): Promise<void> {
    await this.enqueueAlarmOperation(async () => {
      this.sql.exec(
        `INSERT INTO session_alarm_deadlines (name, deadline)
         VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET deadline = excluded.deadline`,
        concern,
        deadline
      );
      await this.rearmNow();
    });
  }

  async clear(concern: SessionAlarmConcern): Promise<void> {
    await this.enqueueAlarmOperation(async () => {
      this.sql.exec(`DELETE FROM session_alarm_deadlines WHERE name = ?`, concern);
      await this.rearmNow();
    });
  }

  clearDue(now: number): void {
    this.sql.exec(`DELETE FROM session_alarm_deadlines WHERE deadline <= ?`, now);
  }

  /** Runs independent alarm concerns in order without letting one suppress the rest. */
  async run(now: number, tasks: SessionAlarmTask[]): Promise<void> {
    this.clearDue(now);
    const failures: Error[] = [];

    for (const task of tasks) {
      try {
        await task.run();
      } catch (error) {
        const detail = error instanceof Error ? error : new Error(String(error));
        failures.push(new Error(`${task.name}: ${detail.message}`, { cause: detail }));
      }
    }

    try {
      await this.rearm();
    } catch (error) {
      const detail = error instanceof Error ? error : new Error(String(error));
      failures.push(new Error(`rearm: ${detail.message}`, { cause: detail }));
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, failures.map((failure) => failure.message).join("; "));
    }
  }

  async rearm(): Promise<void> {
    await this.enqueueAlarmOperation(() => this.rearmNow());
  }

  private enqueueAlarmOperation(operation: () => Promise<void>): Promise<void> {
    const result = this.alarmOperation.then(operation, operation);
    this.alarmOperation = result.catch(() => undefined);
    return result;
  }

  private async rearmNow(): Promise<void> {
    const rows = this.sql
      .exec(`SELECT MIN(deadline) AS deadline FROM session_alarm_deadlines`)
      .toArray() as Array<{ deadline: number | null }>;
    const deadline = rows[0]?.deadline ?? null;
    if (deadline == null) {
      await this.storage.deleteAlarm();
    } else {
      await this.storage.setAlarm(deadline);
    }
  }
}
