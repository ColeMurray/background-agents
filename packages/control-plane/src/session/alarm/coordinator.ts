import type { SqlStorage } from "../sql-storage";

export type SessionAlarmConcern = "lifecycle" | "execution" | "diff_capture" | "diff_cleanup";

interface AlarmStorage {
  getAlarm(): Promise<number | null>;
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
  private legacyAlarmChecked = false;

  constructor(
    private readonly sql: SqlStorage,
    private readonly storage: AlarmStorage
  ) {}

  async schedule(concern: SessionAlarmConcern, deadline: number): Promise<void> {
    await this.enqueueAlarmOperation(async () => {
      await this.adoptLegacyAlarmNow();
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
      await this.adoptLegacyAlarmNow();
      this.sql.exec(`DELETE FROM session_alarm_deadlines WHERE name = ?`, concern);
      await this.rearmNow();
    });
  }

  clearDue(now: number): void {
    this.sql.exec(`DELETE FROM session_alarm_deadlines WHERE deadline <= ?`, now);
  }

  /** Runs independent alarm concerns in order without letting one suppress the rest. */
  async run(now: number, tasks: SessionAlarmTask[]): Promise<void> {
    await this.enqueueAlarmOperation(async () => {
      await this.adoptLegacyAlarmNow();
      this.clearDue(now);
    });
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
    await this.enqueueAlarmOperation(async () => {
      await this.adoptLegacyAlarmNow();
      await this.rearmNow();
    });
  }

  private enqueueAlarmOperation(operation: () => Promise<void>): Promise<void> {
    const result = this.alarmOperation.then(operation, operation);
    this.alarmOperation = result.catch(() => undefined);
    return result;
  }

  private async rearmNow(): Promise<void> {
    const deadline = this.getMinimumDeadline();
    if (deadline == null) {
      await this.storage.deleteAlarm();
    } else {
      await this.storage.setAlarm(deadline);
    }
  }

  private async adoptLegacyAlarmNow(): Promise<void> {
    if (this.legacyAlarmChecked) return;
    if (this.getMinimumDeadline() == null) {
      const deadline = await this.storage.getAlarm();
      if (deadline != null) {
        this.sql.exec(
          `INSERT OR IGNORE INTO session_alarm_deadlines (name, deadline) VALUES (?, ?)`,
          "legacy",
          deadline
        );
      }
    }
    this.legacyAlarmChecked = true;
  }

  private getMinimumDeadline(): number | null {
    const rows = this.sql
      .exec(`SELECT MIN(deadline) AS deadline FROM session_alarm_deadlines`)
      .toArray() as Array<{ deadline: number | null }>;
    return rows[0]?.deadline ?? null;
  }
}
