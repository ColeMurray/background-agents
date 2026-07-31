import {
  type ImageBuildRecordView,
  type ImageBuildScopeKind,
  type ImageBuildStatus,
  type RepositoryShaEntry,
} from "@open-inspect/shared";
import type {
  ImageBuildProvider,
  ImageBuildScope,
  MarkImageBuildReadyResult,
  SupersededImageBuild,
} from "../image-builds/model";
import { ImageBuildFinalizationStore } from "./image-build-finalization";
import type { SqlDatabase } from "./sql-database";

const MS_PER_SECOND = 1000;

/** D1 caps bound parameters per statement; IN-list queries chunk below it. */
const MAX_SCOPE_IDS_PER_QUERY = 50;

/**
 * The exact `ImageBuildRecordView` wire columns, in declaration order. Status
 * reads project this list rather than `SELECT *` so internal columns
 * (callback token, provider session/image ids) never reach a client — the
 * table carries columns the wire contract does not.
 *
 * `satisfies` rejects any key outside the wire contract (a leaking column is
 * a compile error); the exhaustiveness assertion below rejects any wire field
 * missing from the projection. The integration tests keep independent
 * hand-written key-set pins on the runtime payload.
 */
const STATUS_VIEW_KEYS = [
  "id",
  "scope_kind",
  "scope_id",
  "provider",
  "status",
  "repositories_fingerprint",
  "repository_shas",
  "runtime_version",
  "build_duration_seconds",
  "error_message",
  "created_at",
] as const satisfies readonly (keyof ImageBuildRecordView)[];

type MissingStatusViewKey = Exclude<keyof ImageBuildRecordView, (typeof STATUS_VIEW_KEYS)[number]>;
// Fails to compile — naming the missing key — if ImageBuildRecordView gains a
// field the projection does not carry.
const _statusViewComplete: MissingStatusViewKey extends never ? true : MissingStatusViewKey = true;
void _statusViewComplete;

const STATUS_VIEW_COLUMNS = STATUS_VIEW_KEYS.join(", ");

// One message for both sweeps (global cron + lazy trigger-time) so a stale
// mark is attributable regardless of which path performed it.
const STALE_BUILD_TIMEOUT_MESSAGE = "build timed out (no callback received)";

/** Registration input for a new building row. */
export interface ImageBuildRegistration {
  id: string;
  scope: ImageBuildScope;
  provider: ImageBuildProvider;
  repositoriesFingerprint: string;
  callbackTokenHash?: string;
  callbackTokenExpiresAt?: number;
}

/**
 * One full row, including the internal columns (callback token, provider
 * session/image ids). Mirrors the `image_builds` table (migration 0039).
 * Internal row — never serialized to clients; the outward wire contract is
 * `ImageBuildRecordView`, and status reads project exactly its columns.
 */
export interface ImageBuildRow extends ImageBuildRecordView {
  provider: ImageBuildProvider;
  provider_image_id: string | null;
  repositories_fingerprint: string;
  provider_session_id: string | null;
  completion_hash: string | null;
  finalization_lease_token: string | null;
  finalization_lease_expires_at: number | null;
  provider_session_cleanup_pending: number | null;
  callback_token_hash: string | null;
  callback_token_expires_at: number | null;
  callback_token_used_at: number | null;
}

/** A row carrying its provider artifact (if any) for the reaper to reclaim. */
export interface ReapableImageBuildRow {
  id: string;
  scope_kind: ImageBuildScopeKind;
  scope_id: string;
  provider: ImageBuildProvider;
  provider_image_id: string | null;
  provider_session_id: string | null;
  created_at: number;
}

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

export const PROVIDER_SESSION_CLEANUP_SQL = `SELECT id, provider, status,
        provider_image_id, provider_session_id, provider_session_cleanup_pending,
        error_message, created_at
 FROM image_builds
 WHERE status IN ('ready', 'failed', 'superseded')
   AND provider_session_id IS NOT NULL
   AND provider_session_cleanup_pending IS NOT 0
 ORDER BY created_at, id`;

export const RECOVERABLE_IMAGE_FINALIZATIONS_SQL = `SELECT id, completion_hash,
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
 ORDER BY callback_token_used_at, id`;

export const SUPERSEDED_IMAGES_SQL = `SELECT id, scope_kind, scope_id, provider,
        provider_image_id, provider_session_id, created_at
 FROM image_builds
 WHERE status = 'superseded'
   AND (provider_session_id IS NULL OR provider_session_cleanup_pending = 0)
 ORDER BY created_at, id`;

export const FAILED_IMAGE_ARTIFACTS_SQL = `SELECT id, scope_kind, scope_id, provider,
        provider_image_id, provider_session_id, created_at
 FROM image_builds
 WHERE status = 'failed' AND provider_image_id IS NOT NULL
   AND (provider_session_id IS NULL OR provider_session_cleanup_pending = 0)
 ORDER BY created_at, id`;

export const DELETE_OLD_FAILED_BUILDS_SQL = `DELETE FROM image_builds
WHERE status = 'failed' AND provider_image_id IS NULL
  AND (provider_session_id IS NULL OR provider_session_cleanup_pending = 0)
  AND created_at < ?`;

export const MARK_STALE_IMAGE_BUILDS_SQL = `UPDATE image_builds
SET status = 'failed',
    error_message = ?,
    finalization_lease_token = NULL,
    finalization_lease_expires_at = NULL
WHERE status = 'building'
  AND created_at < ?
  AND provider_image_id IS NULL
  AND callback_token_used_at IS NULL
  AND completion_hash IS NULL
  AND finalization_lease_token IS NULL`;

/**
 * D1-backed image-build registry and state machine.
 *
 * Conditional updates keep duplicate callbacks and newer-build races free of
 * provider-specific branching. The supersede scope is
 * (scope_kind, scope_id, provider) — the fingerprint covers branches, so
 * there is no branch dimension and at most one live image per scope/provider —
 * and rows can be superseded out-of-band (entity delete, secret change), so a
 * reaper query exposes superseded artifacts for cleanup instead of relying
 * solely on inline deletion at mark-ready time.
 *
 * Scope kind is data here, never dispatch: enablement and any other per-kind
 * question belong to image-builds/scope.ts.
 */
export class ImageBuildStore {
  readonly finalization: ImageBuildFinalizationStore;

  constructor(private readonly db: SqlDatabase) {
    this.finalization = new ImageBuildFinalizationStore(db);
  }

  /**
   * Registers a build unless one is already in flight for the same
   * (scope, provider). The NOT EXISTS guard is the authoritative
   * concurrency-1 gate: it is atomic within the single INSERT statement, so
   * concurrent triggers cannot both insert (the workflow's earlier
   * getActiveBuild read is only a cheap short-circuit). Returns false when a
   * building row already existed and nothing was inserted.
   */
  async registerBuild(build: ImageBuildRegistration): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO image_builds (
           id,
           scope_kind,
           scope_id,
           provider,
           repositories_fingerprint,
           repository_shas,
           runtime_version,
           status,
           callback_token_hash,
           callback_token_expires_at,
           created_at
         )
         SELECT ?, ?, ?, ?, ?, '[]', '', 'building', ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM image_builds
           WHERE scope_kind = ? AND scope_id = ? AND provider = ? AND status = 'building'
         )`
      )
      .bind(
        build.id,
        build.scope.kind,
        build.scope.id,
        build.provider,
        build.repositoriesFingerprint,
        build.callbackTokenHash ?? null,
        build.callbackTokenExpiresAt ?? null,
        Date.now(),
        build.scope.kind,
        build.scope.id,
        build.provider
      )
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  async bindProviderSession(
    buildId: string,
    provider: ImageBuildProvider,
    providerSessionId: string
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE image_builds
         SET provider_session_id = ?, provider_session_cleanup_pending = 1
         WHERE id = ? AND provider = ? AND status = 'building'
           AND (provider_session_id IS NULL OR provider_session_id = ?)`
      )
      .bind(providerSessionId, buildId, provider, providerSessionId)
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  /** The per-scope concurrency guard: at most one in-flight build. */
  async getActiveBuild(
    scope: ImageBuildScope,
    provider: ImageBuildProvider
  ): Promise<{ id: string } | null> {
    return this.db
      .prepare(
        `SELECT id FROM image_builds
         WHERE scope_kind = ? AND scope_id = ? AND provider = ? AND status = 'building'
         ORDER BY created_at DESC LIMIT 1`
      )
      .bind(scope.kind, scope.id, provider)
      .first<{ id: string }>();
  }

  /** Save-hook short-circuit: a ready image already matches the current repository set. */
  async hasReadyImageForFingerprint(
    scope: ImageBuildScope,
    provider: ImageBuildProvider,
    repositoriesFingerprint: string
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS present FROM image_builds
         WHERE scope_kind = ? AND scope_id = ? AND provider = ? AND status = 'ready'
           AND repositories_fingerprint = ?
         LIMIT 1`
      )
      .bind(scope.kind, scope.id, provider, repositoriesFingerprint)
      .first<{ present: number }>();
    return row !== null;
  }

  async tryMarkImageBuildReady(
    buildId: string,
    provider: ImageBuildProvider,
    providerImageId: string,
    repositoryShas: RepositoryShaEntry[],
    runtimeVersion: string,
    buildDurationMs: number,
    finalizationLeaseToken?: string
  ): Promise<MarkImageBuildReadyResult> {
    const build = await this.db
      .prepare(
        "SELECT scope_kind, scope_id, provider_session_id, created_at FROM image_builds WHERE id = ? AND provider = ? AND status = 'building'"
      )
      .bind(buildId, provider)
      .first<{
        scope_kind: ImageBuildScopeKind;
        scope_id: string;
        provider_session_id: string | null;
        created_at: number;
      }>();

    if (!build) {
      return { type: "not_accepting_completion" };
    }

    const leaseSet = finalizationLeaseToken
      ? ", finalization_lease_token = NULL, finalization_lease_expires_at = NULL"
      : "";
    const leaseWhere = finalizationLeaseToken ? " AND finalization_lease_token = ?" : "";

    const updateResult = await this.db
      .prepare(
        `UPDATE image_builds
         SET status = 'ready', provider_image_id = ?, repository_shas = ?, runtime_version = ?, build_duration_seconds = ?${leaseSet}
         WHERE id = ? AND provider = ? AND status = 'building'${leaseWhere}
           AND NOT EXISTS (
             SELECT 1 FROM image_builds newer
             WHERE newer.scope_kind = ?
               AND newer.scope_id = ?
               AND newer.provider = ?
               AND newer.status = 'ready'
               AND (
                 newer.created_at > ?
                 OR (newer.created_at = ? AND newer.id > ?)
               )
           )`
      )
      .bind(
        providerImageId,
        JSON.stringify(repositoryShas),
        runtimeVersion,
        buildDurationMs / MS_PER_SECOND,
        buildId,
        provider,
        ...(finalizationLeaseToken ? [finalizationLeaseToken] : []),
        build.scope_kind,
        build.scope_id,
        provider,
        build.created_at,
        build.created_at,
        buildId
      )
      .run();

    if ((updateResult.meta?.changes ?? 0) === 0) {
      return (
        (await this.tryMarkBuildingBuildSuperseded({
          buildId,
          provider,
          providerImageId,
          providerSessionId: build.provider_session_id,
          repositoryShas,
          runtimeVersion,
          buildDurationMs,
          scopeKind: build.scope_kind,
          scopeId: build.scope_id,
          createdAt: build.created_at,
          finalizationLeaseToken,
        })) ?? { type: "not_accepting_completion" }
      );
    }

    const superseded = await this.db
      .prepare(
        `SELECT id, provider_image_id, provider_session_id FROM image_builds
         WHERE scope_kind = ?
           AND scope_id = ?
           AND provider = ?
           AND status = 'ready'
           AND id <> ?
           AND (
             created_at < ?
             OR (created_at = ? AND id < ?)
           )
         ORDER BY created_at DESC, id DESC`
      )
      .bind(
        build.scope_kind,
        build.scope_id,
        provider,
        buildId,
        build.created_at,
        build.created_at,
        buildId
      )
      .all<{ id: string; provider_image_id: string | null; provider_session_id: string | null }>();

    const supersededImages: SupersededImageBuild[] = (superseded.results || []).map((image) => ({
      imageBuildId: image.id,
      image: {
        providerImageId: image.provider_image_id ?? "",
        providerSessionId: image.provider_session_id,
      },
    }));

    if (superseded.results?.length) {
      await this.db.batch(
        superseded.results.map((image) =>
          this.db
            .prepare(
              "UPDATE image_builds SET status = 'superseded' WHERE id = ? AND status = 'ready'"
            )
            .bind(image.id)
        )
      );
    }

    return {
      type: "marked_ready",
      supersededImages,
    };
  }

  private async tryMarkBuildingBuildSuperseded(params: {
    buildId: string;
    provider: ImageBuildProvider;
    providerImageId: string;
    providerSessionId: string | null;
    repositoryShas: RepositoryShaEntry[];
    runtimeVersion: string;
    buildDurationMs: number;
    scopeKind: ImageBuildScopeKind;
    scopeId: string;
    createdAt: number;
    finalizationLeaseToken?: string;
  }): Promise<Extract<MarkImageBuildReadyResult, { type: "superseded_by_newer_ready" }> | null> {
    const leaseSet = params.finalizationLeaseToken
      ? ", finalization_lease_token = NULL, finalization_lease_expires_at = NULL"
      : "";
    const leaseWhere = params.finalizationLeaseToken ? " AND finalization_lease_token = ?" : "";

    const result = await this.db
      .prepare(
        `UPDATE image_builds
         SET status = 'superseded', provider_image_id = ?, repository_shas = ?, runtime_version = ?, build_duration_seconds = ?${leaseSet}
         WHERE id = ? AND provider = ? AND status = 'building'${leaseWhere}
           AND EXISTS (
             SELECT 1 FROM image_builds newer
             WHERE newer.scope_kind = ?
               AND newer.scope_id = ?
               AND newer.provider = ?
               AND newer.status = 'ready'
               AND (
                 newer.created_at > ?
                 OR (newer.created_at = ? AND newer.id > ?)
               )
           )`
      )
      .bind(
        params.providerImageId,
        JSON.stringify(params.repositoryShas),
        params.runtimeVersion,
        params.buildDurationMs / MS_PER_SECOND,
        params.buildId,
        params.provider,
        ...(params.finalizationLeaseToken ? [params.finalizationLeaseToken] : []),
        params.scopeKind,
        params.scopeId,
        params.provider,
        params.createdAt,
        params.createdAt,
        params.buildId
      )
      .run();

    if ((result.meta?.changes ?? 0) === 0) return null;

    return {
      type: "superseded_by_newer_ready",
      supersededImage: {
        imageBuildId: params.buildId,
        image: {
          providerImageId: params.providerImageId,
          providerSessionId: params.providerSessionId,
        },
      },
    };
  }

  async deleteSupersededImage(
    imageBuildId: string,
    reapedProviderImageId: string | null = null
  ): Promise<boolean> {
    const deleteStatement = this.db
      .prepare(
        `DELETE FROM image_builds
         WHERE id = ? AND status = 'superseded' AND provider_image_id IS NULL
           AND (provider_session_id IS NULL OR provider_session_cleanup_pending = 0)`
      )
      .bind(imageBuildId);

    if (reapedProviderImageId === null) {
      const result = await deleteStatement.run();
      return (result.meta?.changes ?? 0) > 0;
    }

    const [, deleted] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE image_builds SET provider_image_id = NULL
           WHERE id = ? AND status = 'superseded' AND provider_image_id = ?
             AND (provider_session_id IS NULL OR provider_session_cleanup_pending = 0)`
        )
        .bind(imageBuildId, reapedProviderImageId),
      deleteStatement,
    ]);
    return (deleted.meta?.changes ?? 0) > 0;
  }

  async markBuildFailed(
    buildId: string,
    provider: ImageBuildProvider,
    error: string
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE image_builds SET status = 'failed', error_message = ? WHERE id = ? AND provider = ? AND status = 'building'"
      )
      .bind(error, buildId, provider)
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  /**
   * Spawn-side twin of markBuildFailed: a ready image whose provider artifact
   * failed to restore is failed by id, so the rebuild cron sees no matching
   * ready image and rebuilds it on the next tick. Scoped to status='ready' —
   * building rows belong to the build workflow's failure paths and superseded
   * rows to the reaper.
   */
  async markRestoreFailed(imageBuildId: string, error: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE image_builds SET status = 'failed', error_message = ? WHERE id = ? AND status = 'ready'"
      )
      .bind(error, imageBuildId)
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  /**
   * Secret-change invalidation: flip every live image — including in-flight
   * builds, which are baking the outdated values — to superseded. The status
   * flip is the load-bearing part and happens in the save-hook; provider
   * artifacts are reclaimed later by the reaper.
   */
  async supersedeActiveImages(scope: ImageBuildScope): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE image_builds SET status = 'superseded'
         WHERE scope_kind = ? AND scope_id = ? AND status IN ('building', 'ready')`
      )
      .bind(scope.kind, scope.id)
      .run();

    return result.meta?.changes ?? 0;
  }

  /**
   * Spawn-time selection read: the latest ready image for a scope on the
   * active provider. Purely a row read — scope existence and prebuild
   * enablement are the scope resolver's answer (image-builds/scope.ts), which
   * callers consult before serving the row.
   */
  async getLatestReadyForSpawn(
    scope: ImageBuildScope,
    provider: ImageBuildProvider
  ): Promise<ImageBuildRow | null> {
    return await this.db
      .prepare(
        `SELECT * FROM image_builds
         WHERE scope_kind = ? AND scope_id = ? AND provider = ? AND status = 'ready'
         ORDER BY created_at DESC LIMIT 1`
      )
      .bind(scope.kind, scope.id, provider)
      .first<ImageBuildRow>();
  }

  /** Per-scope recent non-superseded rows (settings UI / debugging view). */
  async getStatus(scope: ImageBuildScope): Promise<ImageBuildRecordView[]> {
    const result = await this.db
      .prepare(
        `SELECT ${STATUS_VIEW_COLUMNS} FROM image_builds WHERE scope_kind = ? AND scope_id = ? AND status <> 'superseded' ORDER BY created_at DESC LIMIT 10`
      )
      .bind(scope.kind, scope.id)
      .all<ImageBuildRecordView>();

    return result.results || [];
  }

  /**
   * Authoritative scheduler input for one provider. Unlike the bounded UI
   * history read, this cannot hide a live build behind failures from another
   * provider.
   */
  async getReconciliationStatus(
    scope: ImageBuildScope,
    provider: ImageBuildProvider
  ): Promise<ImageBuildRecordView[]> {
    const result = await this.db
      .prepare(
        `SELECT ${STATUS_VIEW_COLUMNS} FROM image_builds
         WHERE scope_kind = ? AND scope_id = ? AND provider = ?
           AND status IN ('building', 'ready')
         ORDER BY created_at DESC`
      )
      .bind(scope.kind, scope.id, provider)
      .all<ImageBuildRecordView>();

    return result.results || [];
  }

  /**
   * Cross-scope status for the given (enabled) scopes: every non-superseded
   * row, so failed builds are visible in the aggregate feed alongside ready
   * and building rows. Unbounded per scope on purpose: the state machine caps
   * live rows per (scope, provider) at one ready (mark-ready supersedes older
   * readies) plus one building (the registerBuild guard), failed rows age out
   * via the cleanup pass, and a row cap would just reintroduce the risk of
   * ready images dropping out of the cron's view and re-triggering forever.
   */
  async getStatusForEnabledScopes(scopes: ImageBuildScope[]): Promise<ImageBuildRecordView[]> {
    const idsByKind = new Map<ImageBuildScopeKind, string[]>();
    for (const scope of scopes) {
      const ids = idsByKind.get(scope.kind) ?? [];
      ids.push(scope.id);
      idsByKind.set(scope.kind, ids);
    }

    const rows: ImageBuildRecordView[] = [];
    for (const [kind, ids] of idsByKind) {
      for (let offset = 0; offset < ids.length; offset += MAX_SCOPE_IDS_PER_QUERY) {
        const chunk = ids.slice(offset, offset + MAX_SCOPE_IDS_PER_QUERY);
        const placeholders = chunk.map(() => "?").join(", ");
        const result = await this.db
          .prepare(
            `SELECT ${STATUS_VIEW_COLUMNS} FROM image_builds
             WHERE scope_kind = ? AND scope_id IN (${placeholders}) AND status <> 'superseded'`
          )
          .bind(kind, ...chunk)
          .all<ImageBuildRecordView>();
        rows.push(...(result.results || []));
      }
    }

    rows.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1));
    return rows;
  }

  /**
   * Superseded rows for the cleanup reaper. Rows are superseded both inline
   * (mark-ready replacing an older ready) and out-of-band (entity delete,
   * secret change), so cleanup sweeps whatever is left.
   */
  async getSupersededImages(): Promise<ReapableImageBuildRow[]> {
    const result = await this.db.prepare(SUPERSEDED_IMAGES_SQL).all<ReapableImageBuildRow>();

    return result.results || [];
  }

  async listSessionCleanup(): Promise<ImageBuildSessionCleanupRow[]> {
    const result = await this.db
      .prepare(PROVIDER_SESSION_CLEANUP_SQL)
      .all<ImageBuildSessionCleanupRow>();
    return result.results ?? [];
  }

  async listRecoverableFinalizations(now: number): Promise<RecoverableImageBuildFinalizationRow[]> {
    const result = await this.db
      .prepare(RECOVERABLE_IMAGE_FINALIZATIONS_SQL)
      .bind(now)
      .all<RecoverableImageBuildFinalizationRow>();
    return result.results ?? [];
  }

  /**
   * Failed rows still pointing at a provider artifact, for the reaper to
   * reclaim. A restore-failed spawn flips a ready row to failed while it still
   * carries a live provider_image_id (Modal snapshots never expire), so the
   * artifact must be deleted before the age-based sweep may remove the row.
   * The failed row itself is kept — its error_message stays visible in the
   * status feeds — until clearFailedImageArtifact nulls its artifact columns.
   */
  async getFailedImagesWithArtifacts(): Promise<ReapableImageBuildRow[]> {
    const result = await this.db.prepare(FAILED_IMAGE_ARTIFACTS_SQL).all<ReapableImageBuildRow>();

    return result.results || [];
  }

  /**
   * Terminal reaper action for a failed row whose provider artifact was
   * deleted: null the artifact columns while keeping status='failed' and its
   * error_message. Scoped to status='failed' so a concurrent rebuild that
   * already superseded/replaced the row can never have its live artifact
   * cleared, and to the exact provider_image_id the caller reaped so a newer
   * artifact attached to the same failed row between select and clear is never
   * nulled without being deleted provider-side. Idempotent — a row with no
   * artifact is not re-selected by getFailedImagesWithArtifacts. A null id
   * (never produced by that selector) matches nothing and clears no row.
   */
  async clearFailedImageArtifact(
    imageBuildId: string,
    reapedProviderImageId: string | null
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE image_builds SET provider_image_id = NULL, provider_session_id = NULL
         WHERE id = ? AND status = 'failed' AND provider_image_id = ?
           AND (provider_session_id IS NULL OR provider_session_cleanup_pending = 0)`
      )
      .bind(imageBuildId, reapedProviderImageId)
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  async markStaleBuildsAsFailed(maxAgeMs: number): Promise<number> {
    const now = Date.now();
    const cutoff = now - maxAgeMs;
    const result = await this.db
      .prepare(MARK_STALE_IMAGE_BUILDS_SQL)
      .bind(STALE_BUILD_TIMEOUT_MESSAGE, cutoff)
      .run();

    return result.meta?.changes ?? 0;
  }

  /**
   * Scoped twin of markStaleBuildsAsFailed for lazy trigger-time recovery: a
   * dead `building` row otherwise wedges its scope forever on deployments
   * with no sweep (the concurrency-1 guard has no age cutoff).
   */
  async markScopeStaleBuildFailed(
    scope: ImageBuildScope,
    provider: ImageBuildProvider,
    maxAgeMs: number
  ): Promise<number> {
    const now = Date.now();
    const cutoff = now - maxAgeMs;
    const result = await this.db
      .prepare(
        `UPDATE image_builds
         SET status = 'failed',
             error_message = ?,
             finalization_lease_token = NULL,
             finalization_lease_expires_at = NULL
         WHERE scope_kind = ? AND scope_id = ? AND provider = ? AND status = 'building'
           AND created_at < ?
           AND provider_image_id IS NULL
           AND callback_token_used_at IS NULL
           AND completion_hash IS NULL
           AND finalization_lease_token IS NULL
         ORDER BY created_at, id
         LIMIT 1`
      )
      .bind(STALE_BUILD_TIMEOUT_MESSAGE, scope.kind, scope.id, provider, cutoff)
      .run();

    return result.meta?.changes ?? 0;
  }

  /**
   * Age out failed rows once they hold no provider artifact. The
   * provider_image_id IS NULL guard keeps a restore-failed row (which carries
   * a live artifact) from being hard-deleted before the reaper reclaims the
   * artifact and nulls its columns, which would otherwise orphan the snapshot.
   */
  async deleteOldFailedBuilds(maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    const result = await this.db.prepare(DELETE_OLD_FAILED_BUILDS_SQL).bind(cutoff).run();

    return result.meta?.changes ?? 0;
  }
}
