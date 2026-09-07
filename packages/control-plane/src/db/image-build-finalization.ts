import type {
  ImageBuildScopeKind,
  ImageBuildStatus,
  RepositoryShaEntry,
} from "@open-inspect/shared/types/image-builds";
import { timingSafeEqual } from "@open-inspect/shared/auth";
import type { ImageBuildCallbackBuild, ImageBuildProvider } from "../image-builds/model";
import type { SqlDatabase } from "./sql-database";

interface CallbackTokenRow {
  id: string;
  scope_kind: ImageBuildScopeKind;
  scope_id: string;
  provider: ImageBuildProvider;
  provider_session_id: string | null;
  status: ImageBuildStatus;
  callback_token_hash: string | null;
  callback_token_expires_at: number | null;
  callback_token_used_at: number | null;
}

/** Result of atomically consuming or replaying a callback completion. */
export type ImageBuildCompletionAcceptance = "accepted" | "replayed" | "rejected";

/** Whether callback credentials are fresh or belong to an accepted replay. */
/** Internal columns required to resume Queue finalization and session cleanup. */
export interface ImageBuildFinalizationRow {
  id: string;
  provider: ImageBuildProvider;
  status: ImageBuildStatus;
  provider_image_id: string | null;
  provider_session_id: string | null;
  completion_hash: string | null;
  repository_shas: string;
  runtime_version: string;
  build_duration_seconds: number | null;
  error_message: string | null;
  finalization_lease_token: string | null;
  finalization_lease_expires_at: number | null;
  provider_session_cleanup_pending: number | null;
  callback_token_used_at: number | null;
}

/** D1 operations owned by callback acceptance and Queue finalization. */
export class ImageBuildFinalizationStore {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Atomically consumes a fresh callback token and persists success metadata.
   * An exact duplicate is reported as a replay; any conflicting or stale
   * callback is rejected without changing the row.
   */
  async acceptSuccessfulCompletion(params: {
    buildId: string;
    provider: ImageBuildProvider;
    providerSessionId: string;
    tokenHash: string;
    completionHash: string;
    repositoryShas: RepositoryShaEntry[];
    runtimeVersion: string;
    buildDurationSeconds: number;
    now: number;
  }): Promise<ImageBuildCompletionAcceptance> {
    const result = await this.db
      .prepare(
        `UPDATE image_builds
         SET completion_hash = ?,
             repository_shas = ?,
             runtime_version = ?,
             build_duration_seconds = ?,
             callback_token_used_at = ?
         WHERE id = ? AND provider = ? AND provider_session_id = ? AND status = 'building'
           AND callback_token_hash = ?
           AND callback_token_expires_at >= ?
           AND callback_token_used_at IS NULL`
      )
      .bind(
        params.completionHash,
        JSON.stringify(params.repositoryShas),
        params.runtimeVersion,
        params.buildDurationSeconds,
        params.now,
        params.buildId,
        params.provider,
        params.providerSessionId,
        params.tokenHash,
        params.now
      )
      .run();

    if ((result.meta?.changes ?? 0) > 0) return "accepted";
    return this.readReplayAcceptance(params);
  }

  /**
   * Atomically terminalizes a runtime failure while retaining its provider
   * session as a durable cleanup obligation.
   */
  async acceptFailedCompletion(params: {
    buildId: string;
    provider: ImageBuildProvider;
    providerSessionId: string;
    tokenHash: string;
    completionHash: string;
    errorMessage: string;
    now: number;
  }): Promise<ImageBuildCompletionAcceptance> {
    const result = await this.db
      .prepare(
        `UPDATE image_builds
         SET status = 'failed',
             completion_hash = ?,
             error_message = ?,
             callback_token_used_at = ?
         WHERE id = ? AND provider = ? AND provider_session_id = ? AND status = 'building'
           AND callback_token_hash = ?
           AND callback_token_expires_at >= ?
           AND callback_token_used_at IS NULL`
      )
      .bind(
        params.completionHash,
        params.errorMessage,
        params.now,
        params.buildId,
        params.provider,
        params.providerSessionId,
        params.tokenHash,
        params.now
      )
      .run();

    if ((result.meta?.changes ?? 0) > 0) return "accepted";
    return this.readReplayAcceptance(params);
  }

  private async readReplayAcceptance(params: {
    buildId: string;
    provider: ImageBuildProvider;
    providerSessionId: string;
    tokenHash: string;
    completionHash: string;
  }): Promise<ImageBuildCompletionAcceptance> {
    const replay = await this.db
      .prepare(
        `SELECT 1 AS matches
         FROM image_builds
         WHERE id = ? AND provider = ? AND provider_session_id = ?
           AND callback_token_hash = ?
           AND callback_token_used_at IS NOT NULL
           AND completion_hash = ?`
      )
      .bind(
        params.buildId,
        params.provider,
        params.providerSessionId,
        params.tokenHash,
        params.completionHash
      )
      .first<{ matches: number }>();
    return replay ? "replayed" : "rejected";
  }

  /**
   * Authenticates a callback against its build and bound provider session.
   * Accepted callbacks remain authorizable so a lost HTTP response can safely
   * republish the same Queue command.
   */
  async authorizeCompletionCallback(params: {
    buildId: string;
    providerSessionId: string;
    tokenHash: string;
    now: number;
  }): Promise<ImageBuildCallbackBuild | null> {
    const row = await this.readCallbackTokenRowByBuildId(params.buildId);
    if (!row || !row.callback_token_hash) return null;
    if (!timingSafeEqual(row.callback_token_hash, params.tokenHash)) return null;
    if (row.provider_session_id !== params.providerSessionId) return null;

    const build: ImageBuildCallbackBuild = {
      id: row.id,
      scope: { kind: row.scope_kind, id: row.scope_id },
      provider: row.provider,
      status: row.status,
    };

    // An already-accepted callback (used token + persisted completion hash)
    // stays authorizable so a lost HTTP response can republish safely.
    if (row.callback_token_used_at !== null && row.completion_hash) {
      return build;
    }
    if (
      row.status === "building" &&
      row.callback_token_used_at === null &&
      row.callback_token_expires_at !== null &&
      row.callback_token_expires_at >= params.now
    ) {
      return build;
    }
    return null;
  }

  private async readCallbackTokenRowByBuildId(
    buildId: string
  ): Promise<(CallbackTokenRow & { completion_hash: string | null }) | null> {
    return this.db
      .prepare(
        `SELECT id, scope_kind, scope_id, provider, provider_session_id, status,
                callback_token_hash, callback_token_expires_at, callback_token_used_at,
                completion_hash
         FROM image_builds WHERE id = ?`
      )
      .bind(buildId)
      .first<CallbackTokenRow & { completion_hash: string | null }>();
  }

  /** Reads the durable state used by a Queue delivery or cleanup retry. */
  async getBuild(buildId: string): Promise<ImageBuildFinalizationRow | null> {
    return this.db
      .prepare(
        `SELECT id, provider, status, provider_image_id, provider_session_id,
                completion_hash, repository_shas, runtime_version, build_duration_seconds,
                error_message, finalization_lease_token, finalization_lease_expires_at,
                provider_session_cleanup_pending, callback_token_used_at
         FROM image_builds WHERE id = ?`
      )
      .bind(buildId)
      .first<ImageBuildFinalizationRow>();
  }

  /**
   * Claims exclusive finalization ownership when no live lease exists.
   * Expired leases may be replaced by a redelivery.
   */
  async claimLease(params: {
    buildId: string;
    completionHash: string;
    leaseToken: string;
    now: number;
    expiresAt: number;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE image_builds
         SET finalization_lease_token = ?, finalization_lease_expires_at = ?
         WHERE id = ? AND status = 'building' AND completion_hash = ?
           AND callback_token_used_at IS NOT NULL
           AND provider_session_id IS NOT NULL
           AND (
             finalization_lease_token IS NULL
             OR finalization_lease_expires_at IS NULL
             OR finalization_lease_expires_at <= ?
           )`
      )
      .bind(params.leaseToken, params.expiresAt, params.buildId, params.completionHash, params.now)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /**
   * Fences a provider artifact to the exact build, completion, session, and
   * lease that created it before any ready-state transition is attempted.
   */
  async recordArtifact(params: {
    buildId: string;
    provider: ImageBuildProvider;
    providerSessionId: string;
    completionHash: string;
    leaseToken: string;
    providerImageId: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE image_builds SET provider_image_id = ?
         WHERE id = ? AND provider = ? AND provider_session_id = ?
           AND status = 'building' AND completion_hash = ?
           AND finalization_lease_token = ? AND provider_image_id IS NULL`
      )
      .bind(
        params.providerImageId,
        params.buildId,
        params.provider,
        params.providerSessionId,
        params.completionHash,
        params.leaseToken
      )
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /** Releases a retryable attempt only when the caller still owns its lease. */
  async clearLease(buildId: string, leaseToken: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE image_builds
         SET finalization_lease_token = NULL, finalization_lease_expires_at = NULL
         WHERE id = ? AND finalization_lease_token = ?`
      )
      .bind(buildId, leaseToken)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /** Terminalizes an ambiguous attempt only when the caller owns the lease. */
  async markFailed(params: {
    buildId: string;
    leaseToken: string;
    error: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE image_builds
         SET status = 'failed', error_message = ?,
             finalization_lease_token = NULL, finalization_lease_expires_at = NULL
         WHERE id = ? AND status = 'building' AND finalization_lease_token = ?`
      )
      .bind(params.error, params.buildId, params.leaseToken)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /**
   * Preserve an artifact whose compensating provider deletion failed. The
   * status is terminalized only when it is still building; an out-of-band
   * supersede remains superseded so the normal reaper owns deletion.
   */
  async quarantineArtifact(params: {
    buildId: string;
    provider: ImageBuildProvider;
    providerSessionId: string;
    completionHash: string;
    providerImageId: string;
    error: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE image_builds
         SET provider_image_id = ?,
             status = CASE WHEN status = 'building' THEN 'failed' ELSE status END,
             error_message = CASE WHEN status = 'building' THEN ? ELSE error_message END,
             finalization_lease_token = NULL,
             finalization_lease_expires_at = NULL
         WHERE id = ? AND provider = ? AND provider_session_id = ?
           AND completion_hash = ? AND provider_image_id IS NULL
           AND status IN ('building', 'failed', 'superseded')`
      )
      .bind(
        params.providerImageId,
        params.error,
        params.buildId,
        params.provider,
        params.providerSessionId,
        params.completionHash
      )
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /**
   * Clears an idempotent teardown obligation for the exact provider session.
   * Failed builds drop their now-useless session id; image-bearing rows retain
   * it because provider artifact deletion may require that provenance.
   */
  async clearSessionCleanup(params: {
    buildId: string;
    provider: ImageBuildProvider;
    providerSessionId: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE image_builds
         SET provider_session_cleanup_pending = 0,
             provider_session_id = CASE
               WHEN provider_image_id IS NULL THEN NULL
               ELSE provider_session_id
             END
         WHERE id = ? AND provider = ? AND provider_session_id = ?
           AND status IN ('ready', 'failed', 'superseded')
           AND provider_session_cleanup_pending IS NOT 0`
      )
      .bind(params.buildId, params.provider, params.providerSessionId)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }
}
