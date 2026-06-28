import { timingSafeEqual } from "@open-inspect/shared";

export type RepoImageProvider = "modal" | "vercel" | "opencomputer";

export interface RepoImageBuild {
  id: string;
  repoOwner: string;
  repoName: string;
  provider: RepoImageProvider;
  baseBranch: string;
  callbackTokenHash?: string;
  callbackTokenExpiresAt?: number;
}

export interface RepoImage {
  id: string;
  repo_owner: string;
  repo_name: string;
  provider: RepoImageProvider;
  provider_session_id: string | null;
  provider_image_id: string;
  base_sha: string;
  base_branch: string;
  status: "building" | "ready" | "failed";
  build_duration_seconds: number | null;
  error_message: string | null;
  callback_token_hash: string | null;
  callback_token_expires_at: number | null;
  callback_token_used_at: number | null;
  created_at: number;
}

export interface RepoImageCallbackBuild {
  id: string;
  provider: RepoImageProvider;
  provider_session_id: string | null;
}

export interface ReplacedRepoImage {
  providerImageId: string;
  providerSessionId: string | null;
}

export class RepoImageStore {
  constructor(private readonly db: D1Database) {}

  async registerBuild(build: RepoImageBuild): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO repo_images (
           id,
           repo_owner,
           repo_name,
           provider,
           base_branch,
           provider_image_id,
           status,
           base_sha,
           callback_token_hash,
           callback_token_expires_at,
           created_at
         )
         VALUES (?, ?, ?, ?, ?, '', 'building', '', ?, ?, ?)`
      )
      .bind(
        build.id,
        build.repoOwner.toLowerCase(),
        build.repoName.toLowerCase(),
        build.provider,
        build.baseBranch,
        build.callbackTokenHash ?? null,
        build.callbackTokenExpiresAt ?? null,
        now
      )
      .run();
  }

  async bindProviderSession(
    buildId: string,
    provider: RepoImageProvider,
    providerSessionId: string
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE repo_images SET provider_session_id = ? WHERE id = ? AND provider = ? AND status = 'building'"
      )
      .bind(providerSessionId, buildId, provider)
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  async consumeCallbackToken(params: {
    buildId: string;
    provider: RepoImageProvider;
    tokenHash: string;
    providerSessionId: string;
    now: number;
  }): Promise<RepoImageCallbackBuild | null> {
    const build = await this.db
      .prepare(
        `SELECT id, provider, provider_session_id, status, callback_token_hash, callback_token_expires_at, callback_token_used_at
         FROM repo_images WHERE id = ? AND provider = ?`
      )
      .bind(params.buildId, params.provider)
      .first<{
        id: string;
        provider: RepoImageProvider;
        provider_session_id: string | null;
        status: RepoImage["status"];
        callback_token_hash: string | null;
        callback_token_expires_at: number | null;
        callback_token_used_at: number | null;
      }>();

    if (!build || build.status !== "building") return null;
    if (!build.callback_token_hash || !build.callback_token_expires_at) return null;
    if (build.callback_token_used_at !== null) return null;
    if (build.callback_token_expires_at < params.now) return null;
    if (!timingSafeEqual(build.callback_token_hash, params.tokenHash)) return null;
    if (build.provider_session_id !== params.providerSessionId) {
      return null;
    }

    const result = await this.db
      .prepare(
        `UPDATE repo_images SET callback_token_used_at = ?
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
      provider: build.provider,
      provider_session_id: build.provider_session_id,
    };
  }

  async markBuildReady(
    buildId: string,
    provider: RepoImageProvider,
    providerImageId: string,
    baseSha: string,
    buildDurationSeconds: number
  ): Promise<{
    updated: boolean;
    replacedImageId: string | null;
    replacedProviderSessionId: string | null;
    replacedImages: ReplacedRepoImage[];
  }> {
    const build = await this.db
      .prepare(
        "SELECT repo_owner, repo_name, provider, base_branch, created_at FROM repo_images WHERE id = ? AND provider = ? AND status = 'building'"
      )
      .bind(buildId, provider)
      .first<{
        repo_owner: string;
        repo_name: string;
        provider: RepoImageProvider;
        base_branch: string;
        created_at: number;
      }>();

    if (!build) {
      return {
        updated: false,
        replacedImageId: null,
        replacedProviderSessionId: null,
        replacedImages: [],
      };
    }

    const updateResult = await this.db
      .prepare(
        `UPDATE repo_images
         SET status = 'ready', provider_image_id = ?, base_sha = ?, build_duration_seconds = ?
         WHERE id = ? AND provider = ? AND status = 'building'
           AND NOT EXISTS (
             SELECT 1 FROM repo_images newer
             WHERE newer.repo_owner = ?
               AND newer.repo_name = ?
               AND newer.provider = ?
               AND newer.base_branch = ?
               AND newer.status = 'ready'
               AND (
                 newer.created_at > ?
                 OR (newer.created_at = ? AND newer.id > ?)
               )
           )`
      )
      .bind(
        providerImageId,
        baseSha,
        buildDurationSeconds,
        buildId,
        provider,
        build.repo_owner,
        build.repo_name,
        build.provider,
        build.base_branch,
        build.created_at,
        build.created_at,
        buildId
      )
      .run();

    if ((updateResult.meta?.changes ?? 0) === 0) {
      return {
        updated: false,
        replacedImageId: null,
        replacedProviderSessionId: null,
        replacedImages: [],
      };
    }

    const superseded = await this.db
      .prepare(
        `SELECT id, provider_image_id, provider_session_id FROM repo_images
         WHERE repo_owner = ?
           AND repo_name = ?
           AND provider = ?
           AND base_branch = ?
           AND status = 'ready'
           AND id <> ?
           AND (
             created_at < ?
             OR (created_at = ? AND id < ?)
           )
         ORDER BY created_at DESC, id DESC`
      )
      .bind(
        build.repo_owner,
        build.repo_name,
        build.provider,
        build.base_branch,
        buildId,
        build.created_at,
        build.created_at,
        buildId
      )
      .all<{ id: string; provider_image_id: string; provider_session_id: string | null }>();

    const replacedImages = (superseded.results || []).map((image) => ({
      providerImageId: image.provider_image_id,
      providerSessionId: image.provider_session_id,
    }));

    if (superseded.results?.length) {
      await this.db.batch(
        superseded.results.map((image) =>
          this.db.prepare("DELETE FROM repo_images WHERE id = ?").bind(image.id)
        )
      );
    }

    return {
      updated: true,
      replacedImageId: replacedImages[0]?.providerImageId ?? null,
      replacedProviderSessionId: replacedImages[0]?.providerSessionId ?? null,
      replacedImages,
    };
  }

  async markBuildFailed(
    buildId: string,
    provider: RepoImageProvider,
    error: string
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE repo_images SET status = 'failed', error_message = ? WHERE id = ? AND provider = ? AND status = 'building'"
      )
      .bind(error, buildId, provider)
      .run();

    return (result.meta?.changes ?? 0) > 0;
  }

  async getLatestReady(
    repoOwner: string,
    repoName: string,
    provider: RepoImageProvider,
    baseBranch?: string
  ): Promise<RepoImage | null> {
    return this.getLatestReadyMatching({ repoOwner, repoName, provider, baseBranch });
  }

  async getLatestReadyForAnyProvider(
    repoOwner: string,
    repoName: string,
    baseBranch?: string
  ): Promise<RepoImage | null> {
    return this.getLatestReadyMatching({ repoOwner, repoName, baseBranch });
  }

  private async getLatestReadyMatching({
    repoOwner,
    repoName,
    provider,
    baseBranch,
  }: {
    repoOwner: string;
    repoName: string;
    provider?: RepoImageProvider;
    baseBranch?: string;
  }): Promise<RepoImage | null> {
    const filters = ["ri.repo_owner = ?", "ri.repo_name = ?"];
    const args: string[] = [repoOwner.toLowerCase(), repoName.toLowerCase()];

    if (baseBranch) {
      filters.push("ri.base_branch = ?");
      args.push(baseBranch);
    }
    if (provider) {
      filters.push("ri.provider = ?");
      args.push(provider);
    }

    filters.push("ri.status = 'ready'", "rm.image_build_enabled = 1");

    return this.db
      .prepare(
        `SELECT ri.* FROM repo_images ri
         INNER JOIN repo_metadata rm ON ri.repo_owner = rm.repo_owner AND ri.repo_name = rm.repo_name
         WHERE ${filters.join(" AND ")}
         ORDER BY ri.created_at DESC LIMIT 1`
      )
      .bind(...args)
      .first<RepoImage>();
  }

  async getStatus(repoOwner: string, repoName: string): Promise<RepoImage[]> {
    const result = await this.db
      .prepare(
        "SELECT * FROM repo_images WHERE repo_owner = ? AND repo_name = ? ORDER BY created_at DESC LIMIT 10"
      )
      .bind(repoOwner.toLowerCase(), repoName.toLowerCase())
      .all<RepoImage>();

    return result.results || [];
  }

  async getAllStatus(): Promise<RepoImage[]> {
    const result = await this.db
      .prepare("SELECT * FROM repo_images ORDER BY created_at DESC LIMIT 100")
      .all<RepoImage>();

    return result.results || [];
  }

  async markStaleBuildsAsFailed(maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    const result = await this.db
      .prepare(
        "UPDATE repo_images SET status = 'failed', error_message = ? WHERE status = 'building' AND created_at < ?"
      )
      .bind("build timed out (no callback received)", cutoff)
      .run();

    return result.meta?.changes ?? 0;
  }

  async deleteOldFailedBuilds(maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    const result = await this.db
      .prepare("DELETE FROM repo_images WHERE status = 'failed' AND created_at < ?")
      .bind(cutoff)
      .run();

    return result.meta?.changes ?? 0;
  }
}
