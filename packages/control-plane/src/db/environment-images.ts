import { timingSafeEqual } from "@open-inspect/shared";
import type {
  EnvironmentImageBuildStatus,
  EnvironmentImageCallbackBuild,
  EnvironmentImageMemberSha,
  EnvironmentImageProvider,
  MarkEnvironmentImageReadyResult,
  SupersededEnvironmentImage,
} from "../environment-images/model";

const MS_PER_SECOND = 1000;

/** Row slice read by the callback-token auth checks. */
interface CallbackTokenRow {
  id: string;
  environment_id: string;
  provider: EnvironmentImageProvider;
  provider_session_id: string | null;
  status: EnvironmentImageBuildStatus;
  callback_token_hash: string | null;
  callback_token_expires_at: number | null;
  callback_token_used_at: number | null;
}

export interface EnvironmentImageBuild {
  id: string;
  environmentId: string;
  provider: EnvironmentImageProvider;
  membersFingerprint: string;
  callbackTokenHash?: string;
  callbackTokenExpiresAt?: number;
}

export interface EnvironmentImage {
  id: string;
  environment_id: string;
  provider: EnvironmentImageProvider;
  provider_image_id: string | null;
  members_fingerprint: string;
  member_shas: string; // JSON EnvironmentImageMemberSha[]
  runtime_version: string;
  status: EnvironmentImageBuildStatus;
  build_duration_seconds: number | null;
  error_message: string | null;
  provider_session_id: string | null;
  callback_token_hash: string | null;
  callback_token_expires_at: number | null;
  callback_token_used_at: number | null;
  created_at: number;
}

/** Superseded row carrying its provider artifact (if any) for the reaper. */
export interface SupersededEnvironmentImageRow {
  id: string;
  environment_id: string;
  provider: EnvironmentImageProvider;
  provider_image_id: string | null;
  provider_session_id: string | null;
}

/**
 * D1-backed environment image registry and state machine.
 *
 * Mirrors RepoImageStore semantics (conditional updates so duplicate
 * callbacks and newer-build races need no provider-specific branching), with
 * two differences owed to the environment model: the supersede scope is
 * (environment_id, provider) — the fingerprint covers branches, so there is
 * no branch dimension and at most one live image per environment/provider —
 * and rows can be superseded out-of-band (environment delete, secret change),
 * so a reaper query exposes superseded artifacts for cleanup instead of
 * relying solely on inline deletion at mark-ready time.
 */
export class EnvironmentImageStore {
  constructor(private readonly db: D1Database) {}

  async registerBuild(build: EnvironmentImageBuild): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO environment_images (
           id,
           environment_id,
           provider,
           members_fingerprint,
           member_shas,
           runtime_version,
           status,
           callback_token_hash,
           callback_token_expires_at,
           created_at
         )
         VALUES (?, ?, ?, ?, '[]', '', 'building', ?, ?, ?)`
      )
      .bind(
        build.id,
        build.environmentId,
        build.provider,
        build.membersFingerprint,
        build.callbackTokenHash ?? null,
        build.callbackTokenExpiresAt ?? null,
        Date.now()
      )
      .run();
  }

  async bindProviderSession(
    buildId: string,
    provider: EnvironmentImageProvider,
    providerSessionId: string
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE environment_images SET provider_session_id = ? WHERE id = ? AND provider = ? AND status = 'building'"
      )
      .bind(providerSessionId, buildId, provider)
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  async consumeCallbackToken(params: {
    buildId: string;
    provider: EnvironmentImageProvider;
    tokenHash: string;
    providerSessionId: string;
    now: number;
  }): Promise<EnvironmentImageCallbackBuild | null> {
    const build = await this.readCallbackTokenRow(params.buildId, params.provider);
    if (!this.callbackTokenRowIsUsable(build, params)) return null;

    const result = await this.db
      .prepare(
        `UPDATE environment_images SET callback_token_used_at = ?
         WHERE id = ? AND provider = ? AND provider_session_id = ? AND status = 'building'
           AND callback_token_hash = ?
           AND callback_token_expires_at >= ?
           AND callback_token_used_at IS NULL`
      )
      .bind(
        params.now,
        params.buildId,
        params.provider,
        params.providerSessionId,
        params.tokenHash,
        params.now
      )
      .run();

    if ((result.meta?.changes ?? 0) === 0) return null;

    return {
      id: build.id,
      environmentId: build.environment_id,
      provider: build.provider,
      providerSessionId: build.provider_session_id,
      status: build.status,
    };
  }

  async markBuildFailedWithCallbackToken(params: {
    buildId: string;
    provider: EnvironmentImageProvider;
    tokenHash: string;
    providerSessionId: string;
    error: string;
    now: number;
  }): Promise<boolean> {
    const build = await this.readCallbackTokenRow(params.buildId, params.provider);
    if (!this.callbackTokenRowIsUsable(build, params)) return false;

    const result = await this.db
      .prepare(
        `UPDATE environment_images
         SET status = 'failed', error_message = ?, callback_token_used_at = ?
         WHERE id = ? AND provider = ? AND provider_session_id = ? AND status = 'building'
           AND callback_token_hash = ?
           AND callback_token_expires_at >= ?
           AND callback_token_used_at IS NULL`
      )
      .bind(
        params.error,
        params.now,
        params.buildId,
        params.provider,
        params.providerSessionId,
        params.tokenHash,
        params.now
      )
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  private async readCallbackTokenRow(
    buildId: string,
    provider: EnvironmentImageProvider
  ): Promise<CallbackTokenRow | null> {
    return this.db
      .prepare(
        `SELECT id, environment_id, provider, provider_session_id, status,
                callback_token_hash, callback_token_expires_at, callback_token_used_at
         FROM environment_images WHERE id = ? AND provider = ?`
      )
      .bind(buildId, provider)
      .first<CallbackTokenRow>();
  }

  /** Timing-safe, single-use, unexpired token bound to the build's provider session. */
  private callbackTokenRowIsUsable(
    build: CallbackTokenRow | null,
    params: { tokenHash: string; providerSessionId: string; now: number }
  ): build is CallbackTokenRow {
    if (!build || build.status !== "building") return false;
    if (!build.callback_token_hash || !build.callback_token_expires_at) return false;
    if (build.callback_token_used_at !== null) return false;
    if (build.callback_token_expires_at < params.now) return false;
    if (!timingSafeEqual(build.callback_token_hash, params.tokenHash)) return false;
    if (build.provider_session_id !== params.providerSessionId) return false;
    return true;
  }

  /** The per-environment concurrency guard: at most one in-flight build (design §7.3). */
  async getActiveBuild(
    environmentId: string,
    provider: EnvironmentImageProvider
  ): Promise<{ id: string } | null> {
    return this.db
      .prepare(
        `SELECT id FROM environment_images
         WHERE environment_id = ? AND provider = ? AND status = 'building'
         ORDER BY created_at DESC LIMIT 1`
      )
      .bind(environmentId, provider)
      .first<{ id: string }>();
  }

  /** Save-hook short-circuit: a ready image already matches the current member set. */
  async hasReadyImageForFingerprint(
    environmentId: string,
    provider: EnvironmentImageProvider,
    membersFingerprint: string
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS present FROM environment_images
         WHERE environment_id = ? AND provider = ? AND status = 'ready' AND members_fingerprint = ?
         LIMIT 1`
      )
      .bind(environmentId, provider, membersFingerprint)
      .first<{ present: number }>();
    return row !== null;
  }

  async getCallbackBuild(buildId: string): Promise<EnvironmentImageCallbackBuild | null> {
    const build = await this.db
      .prepare(
        "SELECT id, environment_id, provider, provider_session_id, status FROM environment_images WHERE id = ?"
      )
      .bind(buildId)
      .first<{
        id: string;
        environment_id: string;
        provider: EnvironmentImageProvider;
        provider_session_id: string | null;
        status: EnvironmentImageBuildStatus;
      }>();

    if (!build || build.status !== "building") return null;
    return {
      id: build.id,
      environmentId: build.environment_id,
      provider: build.provider,
      providerSessionId: build.provider_session_id,
      status: build.status,
    };
  }

  async tryMarkEnvironmentImageReady(
    buildId: string,
    provider: EnvironmentImageProvider,
    providerImageId: string,
    memberShas: EnvironmentImageMemberSha[],
    runtimeVersion: string,
    buildDurationMs: number
  ): Promise<MarkEnvironmentImageReadyResult> {
    const build = await this.db
      .prepare(
        "SELECT environment_id, provider_session_id, created_at FROM environment_images WHERE id = ? AND provider = ? AND status = 'building'"
      )
      .bind(buildId, provider)
      .first<{
        environment_id: string;
        provider_session_id: string | null;
        created_at: number;
      }>();

    if (!build) {
      return { type: "not_accepting_completion" };
    }

    const updateResult = await this.db
      .prepare(
        `UPDATE environment_images
         SET status = 'ready', provider_image_id = ?, member_shas = ?, runtime_version = ?, build_duration_seconds = ?
         WHERE id = ? AND provider = ? AND status = 'building'
           AND NOT EXISTS (
             SELECT 1 FROM environment_images newer
             WHERE newer.environment_id = ?
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
        JSON.stringify(memberShas),
        runtimeVersion,
        buildDurationMs / MS_PER_SECOND,
        buildId,
        provider,
        build.environment_id,
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
          memberShas,
          runtimeVersion,
          buildDurationMs,
          environmentId: build.environment_id,
          createdAt: build.created_at,
        })) ?? { type: "not_accepting_completion" }
      );
    }

    const superseded = await this.db
      .prepare(
        `SELECT id, provider_image_id, provider_session_id FROM environment_images
         WHERE environment_id = ?
           AND provider = ?
           AND status = 'ready'
           AND id <> ?
           AND (
             created_at < ?
             OR (created_at = ? AND id < ?)
           )
         ORDER BY created_at DESC, id DESC`
      )
      .bind(build.environment_id, provider, buildId, build.created_at, build.created_at, buildId)
      .all<{ id: string; provider_image_id: string | null; provider_session_id: string | null }>();

    const supersededImages: SupersededEnvironmentImage[] = (superseded.results || []).map(
      (image) => ({
        environmentImageId: image.id,
        image: {
          providerImageId: image.provider_image_id ?? "",
          providerSessionId: image.provider_session_id,
        },
      })
    );

    if (superseded.results?.length) {
      await this.db.batch(
        superseded.results.map((image) =>
          this.db
            .prepare(
              "UPDATE environment_images SET status = 'superseded' WHERE id = ? AND status = 'ready'"
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
    provider: EnvironmentImageProvider;
    providerImageId: string;
    providerSessionId: string | null;
    memberShas: EnvironmentImageMemberSha[];
    runtimeVersion: string;
    buildDurationMs: number;
    environmentId: string;
    createdAt: number;
  }): Promise<Extract<
    MarkEnvironmentImageReadyResult,
    { type: "superseded_by_newer_ready" }
  > | null> {
    const result = await this.db
      .prepare(
        `UPDATE environment_images
         SET status = 'superseded', provider_image_id = ?, member_shas = ?, runtime_version = ?, build_duration_seconds = ?
         WHERE id = ? AND provider = ? AND status = 'building'
           AND EXISTS (
             SELECT 1 FROM environment_images newer
             WHERE newer.environment_id = ?
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
        JSON.stringify(params.memberShas),
        params.runtimeVersion,
        params.buildDurationMs / MS_PER_SECOND,
        params.buildId,
        params.provider,
        params.environmentId,
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
        environmentImageId: params.buildId,
        image: {
          providerImageId: params.providerImageId,
          providerSessionId: params.providerSessionId,
        },
      },
    };
  }

  /** Any-status row lookup for late-completion handling. */
  async getBuildRow(buildId: string): Promise<{
    id: string;
    environment_id: string;
    provider: EnvironmentImageProvider;
    status: EnvironmentImageBuildStatus;
  } | null> {
    return this.db
      .prepare("SELECT id, environment_id, provider, status FROM environment_images WHERE id = ?")
      .bind(buildId)
      .first<{
        id: string;
        environment_id: string;
        provider: EnvironmentImageProvider;
        status: EnvironmentImageBuildStatus;
      }>();
  }

  /**
   * Late completion for a build superseded out-of-band (environment delete,
   * secret change) while it was in flight: the callback is rejected, but the
   * provider artifact it reports already exists — record it on the superseded
   * row so the reaper reclaims it instead of leaking it (Modal snapshots
   * never expire). Only artifact-less superseded rows are written, so a
   * ready row's artifact can never be clobbered by a replayed callback.
   */
  async recordArtifactOnSupersededBuild(
    buildId: string,
    provider: EnvironmentImageProvider,
    providerImageId: string
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE environment_images SET provider_image_id = ?
         WHERE id = ? AND provider = ? AND status = 'superseded' AND provider_image_id IS NULL`
      )
      .bind(providerImageId, buildId, provider)
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  async deleteSupersededImage(environmentImageId: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM environment_images WHERE id = ? AND status = 'superseded'")
      .bind(environmentImageId)
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  async markBuildFailed(
    buildId: string,
    provider: EnvironmentImageProvider,
    error: string
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE environment_images SET status = 'failed', error_message = ? WHERE id = ? AND provider = ? AND status = 'building'"
      )
      .bind(error, buildId, provider)
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  /**
   * Secret-change invalidation (design §7.4): flip every live image —
   * including in-flight builds, which are baking the outdated values — to
   * superseded. The status flip is the load-bearing part and happens in the
   * save-hook; provider artifacts are reclaimed later by the reaper.
   */
  async supersedeActiveImages(environmentId: string): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE environment_images SET status = 'superseded'
         WHERE environment_id = ? AND status IN ('building', 'ready')`
      )
      .bind(environmentId)
      .run();

    return result.meta?.changes ?? 0;
  }

  async getStatus(environmentId: string): Promise<EnvironmentImage[]> {
    const result = await this.db
      .prepare(
        "SELECT * FROM environment_images WHERE environment_id = ? AND status <> 'superseded' ORDER BY created_at DESC LIMIT 10"
      )
      .bind(environmentId)
      .all<EnvironmentImage>();

    return result.results || [];
  }

  async getAllStatus(): Promise<EnvironmentImage[]> {
    const result = await this.db
      .prepare(
        "SELECT * FROM environment_images WHERE status <> 'superseded' ORDER BY created_at DESC LIMIT 100"
      )
      .all<EnvironmentImage>();

    return result.results || [];
  }

  /**
   * Superseded rows for the cleanup reaper. Unlike repo images — whose
   * superseded rows are deleted inline right after artifact deletion at
   * mark-ready time — environment images are also superseded out-of-band
   * (environment delete, secret change), so cleanup sweeps whatever is left.
   */
  async getSupersededImages(limit: number): Promise<SupersededEnvironmentImageRow[]> {
    const result = await this.db
      .prepare(
        `SELECT id, environment_id, provider, provider_image_id, provider_session_id
         FROM environment_images WHERE status = 'superseded'
         ORDER BY created_at ASC LIMIT ?`
      )
      .bind(limit)
      .all<SupersededEnvironmentImageRow>();

    return result.results || [];
  }

  async markStaleBuildsAsFailed(maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    const result = await this.db
      .prepare(
        "UPDATE environment_images SET status = 'failed', error_message = ? WHERE status = 'building' AND created_at < ?"
      )
      .bind("build timed out (no callback received)", cutoff)
      .run();

    return result.meta?.changes ?? 0;
  }

  async deleteOldFailedBuilds(maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    const result = await this.db
      .prepare("DELETE FROM environment_images WHERE status = 'failed' AND created_at < ?")
      .bind(cutoff)
      .run();

    return result.meta?.changes ?? 0;
  }
}
