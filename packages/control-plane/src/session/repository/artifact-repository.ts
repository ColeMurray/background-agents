/**
 * ArtifactRepository implementation using SQLite.
 */

import type { ArtifactRepository, CreateArtifactData } from "./types";
import type { ArtifactRow } from "../types";

/**
 * Create an ArtifactRepository instance backed by SQLite.
 */
export function createArtifactRepository(sql: SqlStorage): ArtifactRepository {
  return {
    getById(id: string): ArtifactRow | null {
      const result = sql.exec(`SELECT * FROM artifacts WHERE id = ? LIMIT 1`, id);
      const rows = result.toArray() as ArtifactRow[];
      return rows.length > 0 ? rows[0] : null;
    },

    create(data: CreateArtifactData): ArtifactRow {
      sql.exec(
        `INSERT INTO artifacts (id, type, url, metadata, created_at) VALUES (?, ?, ?, ?, ?)`,
        data.id,
        data.type,
        data.url ?? null,
        data.metadata ?? null,
        data.createdAt
      );

      const created = this.getById(data.id);
      if (!created) {
        throw new Error(`Failed to create artifact ${data.id}`);
      }
      return created;
    },

    list(): ArtifactRow[] {
      const result = sql.exec(`SELECT * FROM artifacts ORDER BY created_at DESC`);
      return result.toArray() as ArtifactRow[];
    },
  };
}
