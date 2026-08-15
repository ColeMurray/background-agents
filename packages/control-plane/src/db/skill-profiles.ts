import type { SkillProfile } from "@open-inspect/shared/types/skills";
import { generateId } from "../auth/crypto";
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

  async list(userId: string): Promise<SkillProfile[]> {
    const result = await this.db
      .prepare(
        `SELECT p.*, COALESCE(json_group_array(i.skill_id) FILTER (WHERE i.skill_id IS NOT NULL), '[]') AS skill_ids
         FROM skill_profiles p
         LEFT JOIN skill_profile_items i ON i.profile_id = p.id
         WHERE p.user_id = ?
         GROUP BY p.id
         ORDER BY lower(p.name), p.id`
      )
      .bind(userId)
      .all<ProfileRow & { skill_ids: string }>();
    return (result.results ?? []).map((row) => this.toProfile(row, JSON.parse(row.skill_ids)));
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
    const placeholders = unique.map(() => "?").join(", ");
    const result = await this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM skills WHERE id IN (${placeholders}) AND deleted_at IS NULL`
      )
      .bind(...unique)
      .first<{ count: number }>();
    if ((result?.count ?? 0) !== unique.length) {
      throw new SkillProfileValidationError("One or more skills do not exist");
    }
  }

  private itemStatements(profileId: string, skillIds: string[]): SqlStatement[] {
    return [...new Set(skillIds)].map((skillId) =>
      this.db
        .prepare("INSERT INTO skill_profile_items (profile_id, skill_id) VALUES (?, ?)")
        .bind(profileId, skillId)
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
