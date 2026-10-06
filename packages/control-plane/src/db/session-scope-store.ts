import { z } from "zod";
import type { SessionVisibility } from "@open-inspect/shared/types/teams";
import type { SqlDatabase, SqlStatement } from "./sql-database";
import { SessionMemorySelectionStore } from "./session-memory-selections";

type SessionAuditStatement = { sessionId: string; statement: SqlStatement };

/** D1 reads and atomic writes for session scope changes. */
export class SessionScopeStore {
  constructor(private readonly db: SqlDatabase) {}

  async listDescendantIds(id: string): Promise<string[]> {
    const rows = await this.db
      .prepare(
        `WITH RECURSIVE descendants(id) AS (
           SELECT id FROM sessions WHERE parent_session_id = ?
           UNION
           SELECT child.id FROM sessions child
           JOIN descendants ON child.parent_session_id = descendants.id
         ) SELECT id FROM descendants`
      )
      .bind(id)
      .all();
    return z
      .array(z.object({ id: z.string() }))
      .parse(rows.results)
      .map((row) => row.id);
  }

  async updateVisibility(
    ids: string[],
    visibility: SessionVisibility,
    audits: SessionAuditStatement[] = []
  ): Promise<void> {
    if (!ids.length) return;
    const auditBySessionId = new Map(
      audits.map(({ sessionId, statement }) => [sessionId, statement])
    );
    await this.db.batch(
      ids.flatMap((id) => {
        const update = this.db
          .prepare("UPDATE sessions SET visibility = ? WHERE id = ?")
          .bind(visibility, id);
        const audit = auditBySessionId.get(id);
        const statements = audit ? [update, audit] : [update];
        if (visibility !== "private") {
          // Once shared, a delayed agent tool call cannot auto-save personal facts,
          // even if the audience is subsequently made private again.
          statements.push(new SessionMemorySelectionStore(this.db).bindRevokePersonalAutoSave(id));
        }
        return statements;
      })
    );
  }
}
