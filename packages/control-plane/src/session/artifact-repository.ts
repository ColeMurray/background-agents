import type { ArtifactType } from "@open-inspect/shared/types/artifacts";
import type { SqlStorage } from "./sql-storage";
import { artifactRowSchema, type ArtifactRow } from "./types";

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

  listArtifacts(): ArtifactRow[] {
    const result = this.sql.exec(`SELECT * FROM artifacts ORDER BY created_at DESC`);
    return result
      .toArray()
      .map((row) => artifactRowSchema.safeParse(row))
      .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
  }

  getArtifactById(artifactId: string): ArtifactRow | null {
    const result = this.sql.exec(`SELECT * FROM artifacts WHERE id = ?`, artifactId);
    const parsed = artifactRowSchema.safeParse(result.toArray()[0]);
    return parsed.success ? parsed.data : null;
  }
}
