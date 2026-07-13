/**
 * EnvironmentStore — D1 persistence for environments and their repositories.
 *
 * Follows the same pattern as AutomationStore / SessionIndexStore: constructor
 * takes D1Database, snake_case rows in the database, camelCase types at the API
 * boundary. Environment secrets live in a separate store (EnvironmentSecretsStore),
 * but their DELETE cascade is composed here so it batches atomically with the
 * repository and image rows (design §7.2).
 */

import type { Environment, EnvironmentRepository } from "@open-inspect/shared";
import { parseJsonStringArray } from "./json-columns";

export interface EnvironmentRow {
  id: string;
  name: string;
  description: string | null;
  prebuild_enabled: number; // SQLite integer boolean
  channel_associations: string | null; // JSON string array (mirrors repo_metadata)
  created_at: number;
  updated_at: number;
}

export interface EnvironmentRepositoryRow {
  environment_id: string;
  position: number;
  repo_owner: string;
  repo_name: string;
  repo_id: number | null;
  base_branch: string;
}

/** Repository values for insert/replace (environment_id supplied by the store). */
export type EnvironmentRepositoryInsert = Pick<
  EnvironmentRepositoryRow,
  "position" | "repo_owner" | "repo_name" | "repo_id" | "base_branch"
>;

export function toEnvironmentRepository(row: EnvironmentRepositoryRow): EnvironmentRepository {
  return {
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    repoId: row.repo_id,
    baseBranch: row.base_branch,
  };
}

/** Map an environment row plus its (position-ordered) repository rows to the response shape. */
export function toEnvironment(
  row: EnvironmentRow,
  repositoryRows: EnvironmentRepositoryRow[]
): Environment {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    prebuildEnabled: row.prebuild_enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    channelAssociations: parseJsonStringArray(row.channel_associations),
    repositories: repositoryRows.map(toEnvironmentRepository),
  };
}

/** The mutable scalar columns of an environment row (everything but id/timestamps). */
export type EnvironmentScalarFields = Partial<
  Pick<EnvironmentRow, "name" | "description" | "prebuild_enabled" | "channel_associations">
>;

const MUTABLE_SCALAR_COLUMNS = [
  "name",
  "description",
  "prebuild_enabled",
  "channel_associations",
] as const satisfies readonly (keyof EnvironmentScalarFields)[];

export class EnvironmentStore {
  constructor(private readonly db: D1Database) {}

  bindEnvironmentInsert(row: EnvironmentRow): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO environments
         (id, name, description, prebuild_enabled, channel_associations, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        row.id,
        row.name,
        row.description,
        row.prebuild_enabled,
        row.channel_associations,
        row.created_at,
        row.updated_at
      );
  }

  /** Insert an environment and its repositories atomically. */
  async create(row: EnvironmentRow, repositories: EnvironmentRepositoryInsert[]): Promise<void> {
    await this.db.batch([
      this.bindEnvironmentInsert(row),
      ...this.bindRepositoryInserts(row.id, repositories),
    ]);
  }

  async getById(id: string): Promise<EnvironmentRow | null> {
    return this.db
      .prepare("SELECT * FROM environments WHERE id = ?")
      .bind(id)
      .first<EnvironmentRow>();
  }

  /**
   * Look up an environment by name, case-insensitively (names are unique under
   * lower(name)). Used to answer the uniqueness pre-check with a 409 before the
   * insert would trip the unique index.
   */
  async getByName(name: string): Promise<EnvironmentRow | null> {
    return this.db
      .prepare("SELECT * FROM environments WHERE lower(name) = lower(?)")
      .bind(name)
      .first<EnvironmentRow>();
  }

  async list(): Promise<{ environments: EnvironmentRow[]; total: number }> {
    const result = await this.db
      .prepare("SELECT * FROM environments ORDER BY created_at DESC")
      .all<EnvironmentRow>();
    const environments = result.results || [];
    return { environments, total: environments.length };
  }

  /**
   * Build the dynamic UPDATE for the mutable scalar fields, or null when nothing
   * scalar changed (a repositories-only edit). `updated_at` is always bumped when
   * a scalar changes; the batch in {@link update} bumps it on repositories-only edits.
   */
  bindEnvironmentUpdate(
    id: string,
    fields: EnvironmentScalarFields,
    now: number
  ): D1PreparedStatement | null {
    const setClauses: string[] = [];
    const params: unknown[] = [];

    for (const field of MUTABLE_SCALAR_COLUMNS) {
      if (field in fields) {
        setClauses.push(`${field} = ?`);
        params.push(fields[field] as unknown);
      }
    }

    if (setClauses.length === 0) return null;

    setClauses.push("updated_at = ?");
    params.push(now);
    params.push(id);

    return this.db
      .prepare(`UPDATE environments SET ${setClauses.join(", ")} WHERE id = ?`)
      .bind(...params);
  }

  /**
   * Update scalar fields and/or replace the repository set atomically.
   * `repositories` of `undefined` leaves the set untouched; any array replaces it
   * wholesale. Returns the refreshed row (null if the environment vanished
   * concurrently).
   */
  async update(
    id: string,
    fields: EnvironmentScalarFields,
    repositories?: EnvironmentRepositoryInsert[]
  ): Promise<EnvironmentRow | null> {
    const now = Date.now();
    const statements: D1PreparedStatement[] = [];

    const updateStmt = this.bindEnvironmentUpdate(id, fields, now);
    if (updateStmt) statements.push(updateStmt);

    if (repositories !== undefined) {
      statements.push(...this.bindReplaceRepositories(id, repositories));
      // A repositories-only edit still bumps updated_at.
      if (!updateStmt) {
        statements.push(
          this.db.prepare("UPDATE environments SET updated_at = ? WHERE id = ?").bind(now, id)
        );
      }
    }

    if (statements.length > 0) await this.db.batch(statements);
    return this.getById(id);
  }

  /**
   * Hard-delete an environment and cascade its dependent rows in one batch:
   * repository rows, secret rows, and superseding any live (building|ready)
   * images so the reaper (PR-10) reclaims their provider artifacts. Sessions
   * created from the environment keep their snapshots and a benignly dangling
   * environment_id (design §7.2).
   *
   * @returns true when the environment existed (idempotent on repeat).
   */
  async delete(id: string): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare("DELETE FROM environment_repositories WHERE environment_id = ?").bind(id),
      this.db.prepare("DELETE FROM environment_secrets WHERE environment_id = ?").bind(id),
      this.db
        .prepare(
          `UPDATE image_builds SET status = 'superseded'
           WHERE scope_kind = 'environment' AND scope_id = ? AND status IN ('building', 'ready')`
        )
        .bind(id),
      this.db.prepare("DELETE FROM environments WHERE id = ?").bind(id),
    ]);
    const envDelete = results[results.length - 1];
    return (envDelete?.meta?.changes ?? 0) > 0;
  }

  async getRepositoriesForEnvironment(environmentId: string): Promise<EnvironmentRepositoryRow[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM environment_repositories
         WHERE environment_id = ?
         ORDER BY position`
      )
      .bind(environmentId)
      .all<EnvironmentRepositoryRow>();
    return result.results || [];
  }

  /** Batched variant for list hydration — one query for a page of environments. */
  async getRepositoriesForEnvironmentIds(
    environmentIds: string[]
  ): Promise<Map<string, EnvironmentRepositoryRow[]>> {
    const map = new Map<string, EnvironmentRepositoryRow[]>();
    for (const id of environmentIds) map.set(id, []);
    if (environmentIds.length === 0) return map;

    const placeholders = environmentIds.map(() => "?").join(", ");
    const result = await this.db
      .prepare(
        `SELECT * FROM environment_repositories
         WHERE environment_id IN (${placeholders})
         ORDER BY position`
      )
      .bind(...environmentIds)
      .all<EnvironmentRepositoryRow>();

    for (const row of result.results ?? []) {
      map.get(row.environment_id)?.push(row);
    }
    return map;
  }

  /**
   * INSERT statements for an environment's repository rows (composable into a
   * batch). The environment_repositories → environments ON DELETE CASCADE FK
   * enforces referential integrity, so a replace against a concurrently-deleted
   * environment is rejected rather than left as orphan rows.
   */
  bindRepositoryInserts(
    environmentId: string,
    repositories: EnvironmentRepositoryInsert[]
  ): D1PreparedStatement[] {
    return repositories.map((repository) =>
      this.db
        .prepare(
          `INSERT INTO environment_repositories
           (environment_id, position, repo_owner, repo_name, repo_id, base_branch)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(
          environmentId,
          repository.position,
          repository.repo_owner,
          repository.repo_name,
          repository.repo_id,
          repository.base_branch
        )
    );
  }

  /** Statements replacing an environment's repository selection. */
  bindReplaceRepositories(
    environmentId: string,
    repositories: EnvironmentRepositoryInsert[]
  ): D1PreparedStatement[] {
    return [
      this.db
        .prepare("DELETE FROM environment_repositories WHERE environment_id = ?")
        .bind(environmentId),
      ...this.bindRepositoryInserts(environmentId, repositories),
    ];
  }

  async replaceRepositories(
    environmentId: string,
    repositories: EnvironmentRepositoryInsert[]
  ): Promise<void> {
    await this.db.batch(this.bindReplaceRepositories(environmentId, repositories));
  }
}
