import type { SessionStatus } from "@open-inspect/shared/types/sessions";
import type { SqlDatabase } from "./sql-database";

interface StatusProjection {
  status: SessionStatus;
  updatedAt: number;
}

/** Compare-and-set repair of an archive's index mirror, without inventing activity. */
export class SessionArchiveProjectionStore {
  constructor(private readonly db: SqlDatabase) {}

  read(id: string): Promise<StatusProjection | null> {
    return this.db
      .prepare("SELECT status, updated_at AS updatedAt FROM sessions WHERE id = ?")
      .bind(id)
      .first<StatusProjection>();
  }

  /** A newer transition or activity touch invalidates the observed projection. */
  async archiveIfUnchanged(id: string, expected: StatusProjection): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE sessions SET status = 'archived' WHERE id = ? AND status = ? AND updated_at = ?"
      )
      .bind(id, expected.status, expected.updatedAt)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }
}
