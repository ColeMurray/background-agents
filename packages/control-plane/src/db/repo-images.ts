export interface RepoImageBuild {
  id: string;
  repoOwner: string;
  repoName: string;
  baseBranch: string;
}

export interface RepoImage {
  id: string;
  repo_owner: string;
  repo_name: string;
  provider_image_id: string;
  base_sha: string;
  base_branch: string;
  status: "building" | "ready" | "failed";
  build_duration_seconds: number | null;
  error_message: string | null;
  created_at: number;
}

export class RepoImageStore {
  constructor(private readonly db: D1Database) {}

  async registerBuild(build: RepoImageBuild): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO repo_images (id, repo_owner, repo_name, base_branch, provider_image_id, status, base_sha, created_at)
         VALUES (?, ?, ?, ?, '', 'building', '', ?)`
      )
      .bind(
        build.id,
        build.repoOwner.toLowerCase(),
        build.repoName.toLowerCase(),
        build.baseBranch,
        now
      )
      .run();
  }

  async markReady(
    buildId: string,
    providerImageId: string,
    baseSha: string,
    buildDurationSeconds: number
  ): Promise<{ replacedImageId: string | null }> {
    const build = await this.db
      .prepare("SELECT repo_owner, repo_name, base_branch FROM repo_images WHERE id = ?")
      .bind(buildId)
      .first<{ repo_owner: string; repo_name: string; base_branch: string }>();

    if (!build) return { replacedImageId: null };

    const oldReady = await this.db
      .prepare(
        "SELECT id, provider_image_id FROM repo_images WHERE repo_owner = ? AND repo_name = ? AND base_branch = ? AND status = 'ready'"
      )
      .bind(build.repo_owner, build.repo_name, build.base_branch)
      .first<{ id: string; provider_image_id: string }>();

    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          "UPDATE repo_images SET status = 'ready', provider_image_id = ?, base_sha = ?, build_duration_seconds = ? WHERE id = ?"
        )
        .bind(providerImageId, baseSha, buildDurationSeconds, buildId),
    ];

    if (oldReady) {
      statements.push(this.db.prepare("DELETE FROM repo_images WHERE id = ?").bind(oldReady.id));
    }

    await this.db.batch(statements);

    return { replacedImageId: oldReady?.provider_image_id ?? null };
  }

  async markFailed(buildId: string, error: string): Promise<void> {
    await this.db
      .prepare("UPDATE repo_images SET status = 'failed', error_message = ? WHERE id = ?")
      .bind(error, buildId)
      .run();
  }

  async getLatestReady(
    repoOwner: string,
    repoName: string,
    baseBranch?: string
  ): Promise<RepoImage | null> {
    if (baseBranch) {
      return this.db
        .prepare(
          `SELECT ri.* FROM repo_images ri
           INNER JOIN repo_metadata rm ON ri.repo_owner = rm.repo_owner AND ri.repo_name = rm.repo_name
           WHERE ri.repo_owner = ? AND ri.repo_name = ? AND ri.base_branch = ? AND ri.status = 'ready'
           AND rm.image_build_enabled = 1
           ORDER BY ri.created_at DESC LIMIT 1`
        )
        .bind(repoOwner.toLowerCase(), repoName.toLowerCase(), baseBranch)
        .first<RepoImage>();
    }
    return this.db
      .prepare(
        `SELECT ri.* FROM repo_images ri
         INNER JOIN repo_metadata rm ON ri.repo_owner = rm.repo_owner AND ri.repo_name = rm.repo_name
         WHERE ri.repo_owner = ? AND ri.repo_name = ? AND ri.status = 'ready'
         AND rm.image_build_enabled = 1
         ORDER BY ri.created_at DESC LIMIT 1`
      )
      .bind(repoOwner.toLowerCase(), repoName.toLowerCase())
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
