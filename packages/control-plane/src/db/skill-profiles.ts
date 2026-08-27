import type { SkillProfile } from "@open-inspect/shared/types/skills";
import { generateId } from "../auth/crypto";
import { bulkInsertStatements } from "./bulk-insert";
import { MAX_D1_QUERY_PARAMETERS } from "./query-limits";
import type { SqlDatabase, SqlStatement } from "./sql-database";

interface ProfileRow {
  id: string;
  user_id: string;
  name: string;
  created_at: number;
  updated_at: number;
}

export class SkillProfileConflictError extends Error {}
export class SkillProfileValidationError extends Error {}

/**
 * Persist user-owned named filters over the shared skill catalog. Profiles do
 * not grant applicability: resolution intersects their IDs with enabled skills
 * assigned to the session target. Every lookup and mutation is owner-scoped.
 *
 * Profile writes advance the shared catalog generation because resolution must
 * retry if profile membership changes while it is constructing a snapshot.
 */
export class SkillProfileStore {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Read every profile this user owns, with its membership.
   *
   * Two statements rather than one `json_group_array` aggregate. The aggregate
   * builds a profile's whole membership into a single value, which the engine
   * caps at 2 MB — roughly fifty thousand ids. Nothing bounds profile width, so
   * that ceiling is only out of reach because the write path gives out first,
   * at about 33,000 members. Anything that makes profile writes cheaper moves
   * the write cliff past the read one and turns this into a profile that can be
   * saved and then never loaded, so the read should not depend on the write
   * staying expensive. Grouping in memory has no such ceiling, matches what
   * `getOwned` already does, and drops a SQLite-only aggregate.
   */
  async list(userId: string): Promise<SkillProfile[]> {
    const profiles = await this.db
      .prepare("SELECT * FROM skill_profiles WHERE user_id = ? ORDER BY lower(name), id")
      .bind(userId)
      .all<ProfileRow>();
    const rows = profiles.results ?? [];
    if (rows.length === 0) return [];

    // Keyed by a subquery rather than by the ids just read, so this costs one
    // parameter however many profiles or members the user has.
    const items = await this.db
      .prepare(
        `SELECT profile_id, skill_id FROM skill_profile_items
         WHERE profile_id IN (SELECT id FROM skill_profiles WHERE user_id = ?)`
      )
      .bind(userId)
      .all<{ profile_id: string; skill_id: string }>();

    const membership = new Map<string, string[]>(rows.map((row) => [row.id, []]));
    for (const item of items.results ?? []) membership.get(item.profile_id)?.push(item.skill_id);
    return rows.map((row) => this.toProfile(row, membership.get(row.id) ?? []));
  }

  /** Return a profile only when it belongs to the canonical user. */
  async getOwned(id: string, userId: string): Promise<SkillProfile | null> {
    const row = await this.db
      .prepare("SELECT * FROM skill_profiles WHERE id = ? AND user_id = ?")
      .bind(id, userId)
      .first<ProfileRow>();
    if (!row) return null;
    const items = await this.db
      .prepare("SELECT skill_id FROM skill_profile_items WHERE profile_id = ? ORDER BY skill_id")
      .bind(id)
      .all<{ skill_id: string }>();
    return this.toProfile(
      row,
      (items.results ?? []).map(({ skill_id }) => skill_id)
    );
  }

  async create(userId: string, name: string, skillIds: string[]): Promise<SkillProfile> {
    const id = `skillprof_${generateId()}`;
    const now = Date.now();
    await this.validateSkillIds(skillIds);
    try {
      await this.db.batch([
        this.db
          .prepare(
            "INSERT INTO skill_profiles (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
          )
          .bind(id, userId, name, now, now),
        ...this.itemStatements(id, skillIds),
        this.bumpGeneration(),
      ]);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new SkillProfileConflictError("A profile with this name already exists");
      }
      throw error;
    }
    return { id, name, skillIds: [...new Set(skillIds)].sort(), createdAt: now, updatedAt: now };
  }

  /** Atomically replace requested fields and profile membership. */
  async update(
    id: string,
    userId: string,
    input: { name?: string; skillIds?: string[] }
  ): Promise<SkillProfile | null> {
    if (!(await this.getOwned(id, userId))) return null;
    if (input.skillIds) await this.validateSkillIds(input.skillIds);
    const statements: SqlStatement[] = [];
    const now = Date.now();
    if (input.name !== undefined) {
      statements.push(
        this.db
          .prepare(
            "UPDATE skill_profiles SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?"
          )
          .bind(input.name, now, id, userId)
      );
    } else if (input.skillIds !== undefined) {
      statements.push(
        this.db
          .prepare("UPDATE skill_profiles SET updated_at = ? WHERE id = ? AND user_id = ?")
          .bind(now, id, userId)
      );
    }
    if (input.skillIds !== undefined) {
      statements.push(
        this.db.prepare("DELETE FROM skill_profile_items WHERE profile_id = ?").bind(id),
        ...this.itemStatements(id, input.skillIds)
      );
    }
    if (statements.length > 0) {
      try {
        await this.db.batch([...statements, this.bumpGeneration()]);
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new SkillProfileConflictError("A profile with this name already exists");
        }
        throw error;
      }
    }
    return this.getOwned(id, userId);
  }

  async delete(id: string, userId: string): Promise<boolean> {
    const results = await this.db.batch([
      this.db
        .prepare(
          "DELETE FROM skill_profile_items WHERE profile_id IN (SELECT id FROM skill_profiles WHERE id = ? AND user_id = ?)"
        )
        .bind(id, userId),
      this.db.prepare("DELETE FROM skill_profiles WHERE id = ? AND user_id = ?").bind(id, userId),
      this.bumpGeneration(),
    ]);
    return (results[1]?.meta.changes ?? 0) > 0;
  }

  /** Reject duplicate, missing, or soft-deleted catalog references before writes. */
  private async validateSkillIds(skillIds: string[]): Promise<void> {
    const unique = [...new Set(skillIds)];
    if (unique.length !== skillIds.length) {
      throw new SkillProfileValidationError("skillIds must be unique");
    }
    if (unique.length === 0) return;
    let found = 0;
    for (let start = 0; start < unique.length; start += MAX_D1_QUERY_PARAMETERS) {
      const chunk = unique.slice(start, start + MAX_D1_QUERY_PARAMETERS);
      const placeholders = chunk.map(() => "?").join(", ");
      const result = await this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM skills WHERE id IN (${placeholders}) AND deleted_at IS NULL`
        )
        .bind(...chunk)
        .first<{ count: number }>();
      found += result?.count ?? 0;
    }
    if (found !== unique.length) {
      throw new SkillProfileValidationError("One or more skills do not exist");
    }
  }

  /**
   * Pack membership rows into multi-row INSERTs. Profile size is caller-chosen,
   * so a statement per member would let one profile write exhaust the
   * invocation's query budget; the statements stay batchable either way.
   */
  private itemStatements(profileId: string, skillIds: string[]): SqlStatement[] {
    return bulkInsertStatements(
      this.db,
      "skill_profile_items",
      [...new Set(skillIds)].map((skillId) => ({ profile_id: profileId, skill_id: skillId }))
    );
  }

  /** Participate in the resolver's cross-store consistency check. */
  private bumpGeneration(): SqlStatement {
    return this.db.prepare(
      "UPDATE skills_catalog_state SET generation = generation + 1 WHERE singleton = 1"
    );
  }

  private toProfile(row: ProfileRow, skillIds: string[]): SkillProfile {
    return {
      id: row.id,
      name: row.name,
      skillIds: skillIds.sort(),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /unique constraint/i.test(error.message);
}
