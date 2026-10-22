import type { SessionStatus } from "@open-inspect/shared/types/sessions";
import type { SqlDatabase } from "./sql-database";
import { IN_PROCESS_HARNESS_SQL } from "./session-row";

/** Owns lifecycle projection writes; activity timestamps never fence status. */
export class SessionStatusProjectionStore {
  constructor(private readonly db: SqlDatabase) {}

  /** Retries are idempotent; a superseded revision cannot overwrite newer state. */
  async project(
    id: string,
    status: SessionStatus,
    revision: number,
    updatedAt: number
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE sessions
         SET status = ${persistedStatusSql()}, status_revision = ?, updated_at = MAX(updated_at, ?)
         WHERE id = ? AND (
           status_revision < ? OR
           (status_revision = ? AND status = ${persistedStatusSql()})
         )`
      )
      .bind(status, status, revision, updatedAt, id, revision, revision, status, status)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /** Initialization failures may update only rows not yet projected by a runtime. */
  async updateUnclaimed(id: string, status: SessionStatus, updatedAt: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE sessions SET status = ${persistedStatusSql()}, updated_at = ?
         WHERE id = ? AND updated_at <= ? AND status_revision = 0`
      )
      .bind(status, status, updatedAt, id, updatedAt)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /** A missing runtime has no authoritative revision; never retire a claimed row. */
  async archiveOrphanedDraft(id: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE sessions SET status = ${persistedStatusSql()}, updated_at = ?
         WHERE id = ? AND status IN ('created', 'durable_created') AND status_revision = 0`
      )
      .bind("archived", "archived", Date.now(), id)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }
}

/** Preserve the fail-closed marker while an in-process session remains promptable. */
function persistedStatusSql(): string {
  return `CASE
    WHEN harness IN (${IN_PROCESS_HARNESS_SQL}) THEN 'durable_' || ?
    ELSE ?
  END`;
}
