import type { ArtifactType } from "@open-inspect/shared/types/artifacts";
import type { SqlStorage } from "./sql-storage";
import type { ArtifactRow } from "./types";
import type { CreatedAtIdCursor } from "./list-cursor";

/** Data for creating an artifact. */
export interface CreateArtifactData {
  id: string;
  type: ArtifactType;
  url: string | null;
  metadata: string | null;
  createdAt: number;
}

/** Data for updating an artifact's content in place (PR lifecycle updates). */
export interface UpdateArtifactData {
  url: string;
  metadata: string | null;
  updatedAt: number;
}

/** Persistence for artifacts scoped to one session. */
export class ArtifactRepository {
  constructor(private readonly sql: SqlStorage) {}

  createArtifact(data: CreateArtifactData): void {
    // updated_at starts at created_at; only content changes advance it.
    this.sql.exec(
      `INSERT INTO artifacts (id, type, url, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      data.id,
      data.type,
      data.url,
      data.metadata,
      data.createdAt,
      data.createdAt
    );
  }

  updateArtifact(artifactId: string, data: UpdateArtifactData): void {
    this.sql.exec(
      `UPDATE artifacts SET url = ?, metadata = ?, updated_at = ? WHERE id = ?`,
      data.url,
      data.metadata,
      data.updatedAt,
      artifactId
    );
  }

  listArtifacts(options?: { cursor: CreatedAtIdCursor | null; limit: number }): ArtifactRow[] {
    const cursorCondition = options?.cursor
      ? `WHERE created_at < ? OR (created_at = ? AND id < ?)`
      : "";
    const params: Array<string | number> = options?.cursor
      ? [options.cursor.createdAt, options.cursor.createdAt, options.cursor.id]
      : [];
    const limit = options ? `LIMIT ?` : "";
    if (options) params.push(options.limit + 1);
    const result = this.sql.exec(
      `SELECT * FROM artifacts ${cursorCondition} ORDER BY created_at DESC, id DESC ${limit}`.trim(),
      ...params
    );
    return result.toArray() as ArtifactRow[];
  }

  getArtifactById(artifactId: string): ArtifactRow | null {
    const result = this.sql.exec(`SELECT * FROM artifacts WHERE id = ?`, artifactId);
    const rows = result.toArray() as ArtifactRow[];
    return rows[0] ?? null;
  }
}
