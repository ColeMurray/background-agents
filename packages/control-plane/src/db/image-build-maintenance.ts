import type { ImageBuildScopeKind, ImageBuildStatus } from "@open-inspect/shared";
import {
  parseRepoScopeId,
  repoImageBuildScope,
  type ImageBuildProvider,
  type ImageBuildScope,
} from "../image-builds/model";
import type { SqlDatabase } from "./sql-database";

export interface ImageBuildSessionCleanupRow {
  id: string;
  provider: ImageBuildProvider;
  status: ImageBuildStatus;
  provider_image_id: string | null;
  provider_session_id: string;
  provider_session_cleanup_pending: number | null;
  error_message: string | null;
  created_at: number;
}

export interface RecoverableImageBuildFinalizationRow {
  id: string;
  completion_hash: string;
  callback_token_used_at: number;
}

export type ImageBuildScopeCursorName = "scope-reconciliation";
export type ImageBuildRowCursorName =
  | "finalization-recovery"
  | "session-cleanup"
  | "failed-image-artifact-cleanup"
  | "superseded-image-artifact-cleanup";

export interface ImageBuildRowCursor {
  sortValue: number;
  rowId: string;
}

export const ENABLED_ENVIRONMENT_FIRST_PAGE_SQL = `SELECT id AS scope_id
 FROM environments
 WHERE prebuild_enabled = 1
 ORDER BY id
 LIMIT ?`;

export const ENABLED_ENVIRONMENT_NEXT_PAGE_SQL = `SELECT id AS scope_id
 FROM environments
 WHERE prebuild_enabled = 1 AND id > ?
 ORDER BY id
 LIMIT ?`;

// repo_metadata has no surrogate id: its canonical key is
// (repo_owner, repo_name). Page over that normalized compound identity rather
// than treating the display name or a concatenated owner/name string as an
// ordering key. Separate start/after statements preserve an indexed seek for
// the after case without an optional-cursor OR predicate.
export const ENABLED_REPOSITORY_FIRST_PAGE_SQL = `SELECT lower(repo_owner) AS repo_owner,
        lower(repo_name) AS repo_name
 FROM repo_metadata
 WHERE image_build_enabled = 1
 ORDER BY lower(repo_owner), lower(repo_name)
 LIMIT ?`;

export const ENABLED_REPOSITORY_NEXT_PAGE_SQL = `SELECT lower(repo_owner) AS repo_owner,
        lower(repo_name) AS repo_name
 FROM repo_metadata
 WHERE image_build_enabled = 1
   AND lower(repo_owner) >= ?
   AND (lower(repo_owner) > ? OR lower(repo_name) > ?)
 ORDER BY lower(repo_owner), lower(repo_name)
 LIMIT ?`;

export const PROVIDER_SESSION_CLEANUP_FIRST_PAGE_SQL = `SELECT id, provider, status,
        provider_image_id, provider_session_id, provider_session_cleanup_pending,
        error_message, created_at
 FROM image_builds
 WHERE status IN ('ready', 'failed', 'superseded')
   AND provider_session_id IS NOT NULL
   AND provider_session_cleanup_pending IS NOT 0
 ORDER BY created_at, id
 LIMIT ?`;

export const PROVIDER_SESSION_CLEANUP_NEXT_PAGE_SQL = `SELECT id, provider, status,
        provider_image_id, provider_session_id, provider_session_cleanup_pending,
        error_message, created_at
 FROM image_builds
 WHERE status IN ('ready', 'failed', 'superseded')
   AND provider_session_id IS NOT NULL
   AND provider_session_cleanup_pending IS NOT 0
   AND (created_at, id) > (?, ?)
 ORDER BY created_at, id
 LIMIT ?`;

export const RECOVERABLE_IMAGE_FINALIZATIONS_FIRST_PAGE_SQL = `SELECT id, completion_hash,
        callback_token_used_at
 FROM image_builds
 WHERE status = 'building'
   AND callback_token_used_at IS NOT NULL
   AND completion_hash IS NOT NULL
   AND (
     finalization_lease_token IS NULL
     OR finalization_lease_expires_at IS NULL
     OR finalization_lease_expires_at <= ?
   )
 ORDER BY callback_token_used_at, id
 LIMIT ?`;

export const RECOVERABLE_IMAGE_FINALIZATIONS_NEXT_PAGE_SQL = `SELECT id, completion_hash,
        callback_token_used_at
 FROM image_builds
 WHERE status = 'building'
   AND callback_token_used_at IS NOT NULL
   AND completion_hash IS NOT NULL
   AND (
     finalization_lease_token IS NULL
     OR finalization_lease_expires_at IS NULL
     OR finalization_lease_expires_at <= ?
   )
   AND (callback_token_used_at, id) > (?, ?)
 ORDER BY callback_token_used_at, id
 LIMIT ?`;

/** D1 pagination and cursor operations owned by periodic maintenance. */
export class ImageBuildMaintenanceStore {
  constructor(private readonly db: SqlDatabase) {}

  async listEnabledScopeRefsPage(params: {
    after: { scopeKind: ImageBuildScopeKind; scopeId: string } | null;
    limit: number;
  }): Promise<{
    scopes: ImageBuildScope[];
    nextCursor: { scopeKind: ImageBuildScopeKind; scopeId: string } | null;
  }> {
    const fetchLimit = params.limit + 1;
    const rows: Array<{ scope_kind: ImageBuildScopeKind; scope_id: string }> = [];

    if (!params.after || params.after.scopeKind === "environment") {
      const afterEnvironmentId =
        params.after?.scopeKind === "environment" ? params.after.scopeId : null;
      const statement = afterEnvironmentId
        ? this.db.prepare(ENABLED_ENVIRONMENT_NEXT_PAGE_SQL).bind(afterEnvironmentId, fetchLimit)
        : this.db.prepare(ENABLED_ENVIRONMENT_FIRST_PAGE_SQL).bind(fetchLimit);
      const result = await statement.all<{ scope_id: string }>();
      rows.push(
        ...(result.results ?? []).map((row) => ({
          scope_kind: "environment" as const,
          scope_id: row.scope_id,
        }))
      );
    }

    if (rows.length < fetchLimit) {
      const afterRepository =
        params.after?.scopeKind === "repo" ? parseRepoScopeId(params.after.scopeId) : null;
      if (params.after?.scopeKind === "repo" && !afterRepository) {
        throw new Error(`Invalid repository scope cursor: ${params.after.scopeId}`);
      }
      const remaining = fetchLimit - rows.length;
      const statement = afterRepository
        ? this.db
            .prepare(ENABLED_REPOSITORY_NEXT_PAGE_SQL)
            .bind(
              afterRepository.repoOwner,
              afterRepository.repoOwner,
              afterRepository.repoName,
              remaining
            )
        : this.db.prepare(ENABLED_REPOSITORY_FIRST_PAGE_SQL).bind(remaining);
      const result = await statement.all<{ repo_owner: string; repo_name: string }>();
      rows.push(
        ...(result.results ?? []).map((row) => ({
          scope_kind: "repo" as const,
          scope_id: repoImageBuildScope(row.repo_owner, row.repo_name).id,
        }))
      );
    }

    const page = rows.slice(0, params.limit);
    const last = page.at(-1);
    return {
      scopes: page.map((row) => ({ kind: row.scope_kind, id: row.scope_id })),
      nextCursor:
        rows.length > params.limit && last
          ? { scopeKind: last.scope_kind, scopeId: last.scope_id }
          : null,
    };
  }

  async getScopeCursor(name: ImageBuildScopeCursorName): Promise<ImageBuildScope | null> {
    const row = await this.db
      .prepare(
        `SELECT cursor_scope_kind, cursor_scope_id
         FROM image_build_scheduler_state WHERE name = ?`
      )
      .bind(name)
      .first<{
        cursor_scope_kind: ImageBuildScopeKind | null;
        cursor_scope_id: string | null;
      }>();
    if (!row?.cursor_scope_kind || !row.cursor_scope_id) return null;
    return { kind: row.cursor_scope_kind, id: row.cursor_scope_id };
  }

  async setScopeCursor(
    name: ImageBuildScopeCursorName,
    cursor: ImageBuildScope | null
  ): Promise<void> {
    if (!cursor) return this.deleteCursor(name);
    await this.upsertCursor(name, {
      scopeKind: cursor.kind,
      scopeId: cursor.id,
      sortValue: null,
      rowId: null,
    });
  }

  async getRowCursor(name: ImageBuildRowCursorName): Promise<ImageBuildRowCursor | null> {
    const row = await this.db
      .prepare(
        `SELECT cursor_sort_value, cursor_row_id
         FROM image_build_scheduler_state WHERE name = ?`
      )
      .bind(name)
      .first<{
        cursor_sort_value: number | null;
        cursor_row_id: string | null;
      }>();
    if (
      row?.cursor_sort_value === null ||
      row?.cursor_sort_value === undefined ||
      !row.cursor_row_id
    )
      return null;
    return { sortValue: row.cursor_sort_value, rowId: row.cursor_row_id };
  }

  async setRowCursor(name: ImageBuildRowCursorName, cursor: ImageBuildRowCursor | null) {
    if (!cursor) return this.deleteCursor(name);
    await this.upsertCursor(name, {
      scopeKind: null,
      scopeId: null,
      sortValue: cursor.sortValue,
      rowId: cursor.rowId,
    });
  }

  private async deleteCursor(name: ImageBuildScopeCursorName | ImageBuildRowCursorName) {
    await this.db
      .prepare("DELETE FROM image_build_scheduler_state WHERE name = ?")
      .bind(name)
      .run();
  }

  private async upsertCursor(
    name: ImageBuildScopeCursorName | ImageBuildRowCursorName,
    cursor: {
      scopeKind: ImageBuildScopeKind | null;
      scopeId: string | null;
      sortValue: number | null;
      rowId: string | null;
    }
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO image_build_scheduler_state
           (name, cursor_scope_kind, cursor_scope_id, cursor_sort_value, cursor_row_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           cursor_scope_kind = excluded.cursor_scope_kind,
           cursor_scope_id = excluded.cursor_scope_id,
           cursor_sort_value = excluded.cursor_sort_value,
           cursor_row_id = excluded.cursor_row_id,
           updated_at = excluded.updated_at`
      )
      .bind(name, cursor.scopeKind, cursor.scopeId, cursor.sortValue, cursor.rowId, Date.now())
      .run();
  }

  async listSessionCleanupPage(params: {
    after: { createdAt: number; rowId: string } | null;
    limit: number;
  }): Promise<ImageBuildSessionCleanupRow[]> {
    const statement = params.after
      ? this.db
          .prepare(PROVIDER_SESSION_CLEANUP_NEXT_PAGE_SQL)
          .bind(params.after.createdAt, params.after.rowId, params.limit)
      : this.db.prepare(PROVIDER_SESSION_CLEANUP_FIRST_PAGE_SQL).bind(params.limit);
    const result = await statement.all<ImageBuildSessionCleanupRow>();
    return result.results ?? [];
  }

  async listRecoverableFinalizations(params: {
    now: number;
    after: { callbackTokenUsedAt: number; rowId: string } | null;
    limit: number;
  }): Promise<RecoverableImageBuildFinalizationRow[]> {
    const statement = params.after
      ? this.db
          .prepare(RECOVERABLE_IMAGE_FINALIZATIONS_NEXT_PAGE_SQL)
          .bind(params.now, params.after.callbackTokenUsedAt, params.after.rowId, params.limit)
      : this.db
          .prepare(RECOVERABLE_IMAGE_FINALIZATIONS_FIRST_PAGE_SQL)
          .bind(params.now, params.limit);
    const result = await statement.all<RecoverableImageBuildFinalizationRow>();
    return result.results ?? [];
  }
}
