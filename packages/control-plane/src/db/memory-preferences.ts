import type { MemoryPreferences } from "@open-inspect/shared/types/memories";
import type { SqlDatabase } from "./sql-database";

/** Per-user memory defaults applied when new sessions resolve; existing manifests never change. */
export class MemoryPreferenceStore {
  constructor(private readonly db: SqlDatabase) {}

  /** Missing preferences opt into personal context. */
  async get(userId: string): Promise<MemoryPreferences> {
    const row = await this.db
      .prepare("SELECT include_personal_memories FROM memory_preferences WHERE user_id = ?")
      .bind(userId)
      .first<{ include_personal_memories: number }>();
    return { includePersonalMemories: row ? row.include_personal_memories === 1 : true };
  }

  async set(userId: string, input: MemoryPreferences): Promise<MemoryPreferences> {
    await this.db
      .prepare(
        `INSERT INTO memory_preferences (user_id, include_personal_memories, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET include_personal_memories = excluded.include_personal_memories, updated_at = excluded.updated_at`
      )
      .bind(userId, input.includePersonalMemories ? 1 : 0, Date.now())
      .run();
    return input;
  }
}
