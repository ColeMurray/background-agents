import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepoImageStore } from "./repo-images";

type RepoImageRow = {
  id: string;
  repo_owner: string;
  repo_name: string;
  provider_image_id: string;
  base_sha: string;
  base_branch: string;
  status: string;
  build_duration_seconds: number | null;
  error_message: string | null;
  created_at: number;
};

const QUERY_PATTERNS = {
  INSERT_BUILD: /^INSERT INTO repo_images/,
  SELECT_BY_ID: /^SELECT repo_owner, repo_name FROM repo_images WHERE id = \?$/,
  SELECT_READY_FOR_REPO:
    /^SELECT id, provider_image_id FROM repo_images WHERE repo_owner = \? AND repo_name = \? AND status = 'ready'$/,
  UPDATE_READY:
    /^UPDATE repo_images SET status = 'ready', provider_image_id = \?, base_sha = \?, build_duration_seconds = \? WHERE id = \?$/,
  DELETE_BY_ID: /^DELETE FROM repo_images WHERE id = \?$/,
  UPDATE_FAILED: /^UPDATE repo_images SET status = 'failed', error_message = \? WHERE id = \?$/,
  SELECT_LATEST_READY:
    /^SELECT \* FROM repo_images WHERE repo_owner = \? AND repo_name = \? AND status = 'ready' ORDER BY created_at DESC LIMIT 1$/,
  SELECT_STATUS:
    /^SELECT \* FROM repo_images WHERE repo_owner = \? AND repo_name = \? ORDER BY created_at DESC LIMIT 10$/,
  SELECT_ALL_STATUS: /^SELECT \* FROM repo_images ORDER BY created_at DESC LIMIT 100$/,
  UPDATE_STALE:
    /^UPDATE repo_images SET status = 'failed', error_message = \? WHERE status = 'building' AND created_at < \?$/,
  DELETE_OLD_FAILED: /^DELETE FROM repo_images WHERE status = 'failed' AND created_at < \?$/,
} as const;

function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

class FakeD1Database {
  private rows = new Map<string, RepoImageRow>();

  prepare(query: string) {
    return new FakePreparedStatement(this, query);
  }

  first(query: string, args: unknown[]): Partial<RepoImageRow> | null {
    const normalized = normalizeQuery(query);

    if (QUERY_PATTERNS.SELECT_BY_ID.test(normalized)) {
      const [id] = args as [string];
      const row = this.rows.get(id);
      return row ? { repo_owner: row.repo_owner, repo_name: row.repo_name } : null;
    }

    if (QUERY_PATTERNS.SELECT_READY_FOR_REPO.test(normalized)) {
      const [owner, name] = args as [string, string];
      for (const row of this.rows.values()) {
        if (row.repo_owner === owner && row.repo_name === name && row.status === "ready") {
          return { id: row.id, provider_image_id: row.provider_image_id };
        }
      }
      return null;
    }

    if (QUERY_PATTERNS.SELECT_LATEST_READY.test(normalized)) {
      const [owner, name] = args as [string, string];
      let latest: RepoImageRow | null = null;
      for (const row of this.rows.values()) {
        if (row.repo_owner === owner && row.repo_name === name && row.status === "ready") {
          if (!latest || row.created_at > latest.created_at) {
            latest = row;
          }
        }
      }
      return latest ? { ...latest } : null;
    }

    throw new Error(`Unexpected first() query: ${normalized}`);
  }

  all(query: string, args: unknown[]): Partial<RepoImageRow>[] {
    const normalized = normalizeQuery(query);

    if (QUERY_PATTERNS.SELECT_STATUS.test(normalized)) {
      const [owner, name] = args as [string, string];
      const results: RepoImageRow[] = [];
      for (const row of this.rows.values()) {
        if (row.repo_owner === owner && row.repo_name === name) {
          results.push({ ...row });
        }
      }
      return results.sort((a, b) => b.created_at - a.created_at).slice(0, 10);
    }

    if (QUERY_PATTERNS.SELECT_ALL_STATUS.test(normalized)) {
      const results: RepoImageRow[] = [];
      for (const row of this.rows.values()) {
        results.push({ ...row });
      }
      return results.sort((a, b) => b.created_at - a.created_at).slice(0, 100);
    }

    throw new Error(`Unexpected all() query: ${normalized}`);
  }

  run(query: string, args: unknown[]): { meta: { changes: number } } {
    const normalized = normalizeQuery(query);

    if (QUERY_PATTERNS.INSERT_BUILD.test(normalized)) {
      // SQL: INSERT ... VALUES (?, ?, ?, ?, '', 'building', '', ?)
      // Bound args: [id, owner, name, branch, createdAt]
      const [id, owner, name, branch, createdAt] = args as [string, string, string, string, number];
      this.rows.set(id, {
        id,
        repo_owner: owner,
        repo_name: name,
        base_branch: branch,
        provider_image_id: "",
        status: "building",
        base_sha: "",
        build_duration_seconds: null,
        error_message: null,
        created_at: createdAt,
      });
      return { meta: { changes: 1 } };
    }

    if (QUERY_PATTERNS.UPDATE_READY.test(normalized)) {
      const [providerImageId, baseSha, buildDuration, id] = args as [
        string,
        string,
        number,
        string,
      ];
      const row = this.rows.get(id);
      if (row) {
        row.status = "ready";
        row.provider_image_id = providerImageId;
        row.base_sha = baseSha;
        row.build_duration_seconds = buildDuration;
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }

    if (QUERY_PATTERNS.DELETE_BY_ID.test(normalized)) {
      const [id] = args as [string];
      const deleted = this.rows.delete(id);
      return { meta: { changes: deleted ? 1 : 0 } };
    }

    if (QUERY_PATTERNS.UPDATE_FAILED.test(normalized)) {
      const [error, id] = args as [string, string];
      const row = this.rows.get(id);
      if (row) {
        row.status = "failed";
        row.error_message = error;
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }

    if (QUERY_PATTERNS.UPDATE_STALE.test(normalized)) {
      const [errorMsg, cutoff] = args as [string, number];
      let changes = 0;
      for (const row of this.rows.values()) {
        if (row.status === "building" && row.created_at < cutoff) {
          row.status = "failed";
          row.error_message = errorMsg;
          changes++;
        }
      }
      return { meta: { changes } };
    }

    if (QUERY_PATTERNS.DELETE_OLD_FAILED.test(normalized)) {
      const [cutoff] = args as [number];
      let changes = 0;
      for (const [id, row] of this.rows.entries()) {
        if (row.status === "failed" && row.created_at < cutoff) {
          this.rows.delete(id);
          changes++;
        }
      }
      return { meta: { changes } };
    }

    throw new Error(`Unexpected mutation query: ${normalized}`);
  }

  async batch(statements: FakePreparedStatement[]) {
    return statements.map((stmt) => stmt.runSync());
  }
}

class FakePreparedStatement {
  private bound: unknown[] = [];

  constructor(
    private db: FakeD1Database,
    private query: string
  ) {}

  bind(...args: unknown[]) {
    this.bound = args;
    return this;
  }

  async first<T>() {
    return this.db.first(this.query, this.bound) as T | null;
  }

  async all<T>() {
    return { results: this.db.all(this.query, this.bound) as T[] };
  }

  async run() {
    return this.db.run(this.query, this.bound);
  }

  runSync() {
    return this.db.run(this.query, this.bound);
  }
}

describe("RepoImageStore", () => {
  let db: FakeD1Database;
  let store: RepoImageStore;

  beforeEach(() => {
    db = new FakeD1Database();
    store = new RepoImageStore(db as unknown as D1Database);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-23T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("registerBuild", () => {
    it("creates a building row", async () => {
      await store.registerBuild({
        id: "img-acme-repo-1000",
        repoOwner: "Acme",
        repoName: "Repo",
        baseBranch: "main",
      });

      const status = await store.getStatus("acme", "repo");
      expect(status).toHaveLength(1);
      expect(status[0].status).toBe("building");
      expect(status[0].repo_owner).toBe("acme");
      expect(status[0].repo_name).toBe("repo");
      expect(status[0].provider_image_id).toBe("");
      expect(status[0].base_sha).toBe("");
    });

    it("normalizes owner and name to lowercase", async () => {
      await store.registerBuild({
        id: "img-1",
        repoOwner: "ACME",
        repoName: "MyRepo",
        baseBranch: "main",
      });

      const status = await store.getStatus("acme", "myrepo");
      expect(status).toHaveLength(1);
      expect(status[0].repo_owner).toBe("acme");
      expect(status[0].repo_name).toBe("myrepo");
    });
  });

  describe("markReady", () => {
    it("updates build to ready with provider image details", async () => {
      await store.registerBuild({
        id: "img-1",
        repoOwner: "acme",
        repoName: "repo",
        baseBranch: "main",
      });

      const result = await store.markReady("img-1", "modal-img-abc", "sha123", 45.2);

      expect(result.replacedImageId).toBeNull();

      const ready = await store.getLatestReady("acme", "repo");
      expect(ready).not.toBeNull();
      expect(ready!.provider_image_id).toBe("modal-img-abc");
      expect(ready!.base_sha).toBe("sha123");
      expect(ready!.build_duration_seconds).toBe(45.2);
      expect(ready!.status).toBe("ready");
    });

    it("replaces previous ready image and returns its ID", async () => {
      await store.registerBuild({
        id: "img-old",
        repoOwner: "acme",
        repoName: "repo",
        baseBranch: "main",
      });
      await store.markReady("img-old", "modal-img-old", "sha-old", 30);

      vi.advanceTimersByTime(60000);

      await store.registerBuild({
        id: "img-new",
        repoOwner: "acme",
        repoName: "repo",
        baseBranch: "main",
      });
      const result = await store.markReady("img-new", "modal-img-new", "sha-new", 40);

      expect(result.replacedImageId).toBe("modal-img-old");

      const ready = await store.getLatestReady("acme", "repo");
      expect(ready).not.toBeNull();
      expect(ready!.id).toBe("img-new");
      expect(ready!.provider_image_id).toBe("modal-img-new");
    });

    it("returns null replacedImageId when no previous ready image", async () => {
      await store.registerBuild({
        id: "img-1",
        repoOwner: "acme",
        repoName: "repo",
        baseBranch: "main",
      });

      const result = await store.markReady("img-1", "modal-img-1", "sha1", 20);
      expect(result.replacedImageId).toBeNull();
    });

    it("returns null for unknown buildId", async () => {
      const result = await store.markReady("nonexistent", "img", "sha", 10);
      expect(result.replacedImageId).toBeNull();
    });
  });

  describe("markFailed", () => {
    it("sets error message and failed status", async () => {
      await store.registerBuild({
        id: "img-1",
        repoOwner: "acme",
        repoName: "repo",
        baseBranch: "main",
      });

      await store.markFailed("img-1", "npm install failed");

      const status = await store.getStatus("acme", "repo");
      expect(status[0].status).toBe("failed");
      expect(status[0].error_message).toBe("npm install failed");
    });
  });

  describe("getLatestReady", () => {
    it("returns null when no ready images exist", async () => {
      const result = await store.getLatestReady("acme", "repo");
      expect(result).toBeNull();
    });

    it("returns null when only building/failed images exist", async () => {
      await store.registerBuild({
        id: "img-1",
        repoOwner: "acme",
        repoName: "repo",
        baseBranch: "main",
      });

      const result = await store.getLatestReady("acme", "repo");
      expect(result).toBeNull();
    });

    it("returns the most recent ready image", async () => {
      await store.registerBuild({
        id: "img-1",
        repoOwner: "acme",
        repoName: "repo",
        baseBranch: "main",
      });
      await store.markReady("img-1", "modal-img-1", "sha1", 30);

      const result = await store.getLatestReady("acme", "repo");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("img-1");
      expect(result!.provider_image_id).toBe("modal-img-1");
    });

    it("is case-insensitive for repo owner and name", async () => {
      await store.registerBuild({
        id: "img-1",
        repoOwner: "acme",
        repoName: "repo",
        baseBranch: "main",
      });
      await store.markReady("img-1", "modal-img-1", "sha1", 30);

      const result = await store.getLatestReady("ACME", "REPO");
      expect(result).not.toBeNull();
    });
  });

  describe("getStatus", () => {
    it("returns empty array for unknown repo", async () => {
      const result = await store.getStatus("acme", "unknown");
      expect(result).toEqual([]);
    });

    it("returns builds in reverse chronological order", async () => {
      await store.registerBuild({
        id: "img-1",
        repoOwner: "acme",
        repoName: "repo",
        baseBranch: "main",
      });

      vi.advanceTimersByTime(60000);

      await store.registerBuild({
        id: "img-2",
        repoOwner: "acme",
        repoName: "repo",
        baseBranch: "main",
      });

      const status = await store.getStatus("acme", "repo");
      expect(status).toHaveLength(2);
      expect(status[0].id).toBe("img-2");
      expect(status[1].id).toBe("img-1");
    });
  });

  describe("getAllStatus", () => {
    it("returns images across all repos", async () => {
      await store.registerBuild({
        id: "img-1",
        repoOwner: "acme",
        repoName: "repo-a",
        baseBranch: "main",
      });
      await store.registerBuild({
        id: "img-2",
        repoOwner: "acme",
        repoName: "repo-b",
        baseBranch: "main",
      });

      const status = await store.getAllStatus();
      expect(status).toHaveLength(2);
    });
  });

  describe("markStaleBuildsAsFailed", () => {
    it("marks old building rows as failed", async () => {
      await store.registerBuild({
        id: "img-old",
        repoOwner: "acme",
        repoName: "repo",
        baseBranch: "main",
      });

      vi.advanceTimersByTime(3600000); // 1 hour

      const count = await store.markStaleBuildsAsFailed(1800000); // 30 min
      expect(count).toBe(1);

      const status = await store.getStatus("acme", "repo");
      expect(status[0].status).toBe("failed");
      expect(status[0].error_message).toBe("build timed out (no callback received)");
    });

    it("does not affect recent building rows", async () => {
      await store.registerBuild({
        id: "img-recent",
        repoOwner: "acme",
        repoName: "repo",
        baseBranch: "main",
      });

      vi.advanceTimersByTime(60000); // 1 minute

      const count = await store.markStaleBuildsAsFailed(1800000); // 30 min
      expect(count).toBe(0);

      const status = await store.getStatus("acme", "repo");
      expect(status[0].status).toBe("building");
    });

    it("does not affect ready or failed rows", async () => {
      await store.registerBuild({
        id: "img-ready",
        repoOwner: "acme",
        repoName: "repo",
        baseBranch: "main",
      });
      await store.markReady("img-ready", "modal-img", "sha1", 30);

      vi.advanceTimersByTime(3600000);

      const count = await store.markStaleBuildsAsFailed(1800000);
      expect(count).toBe(0);
    });
  });

  describe("deleteOldFailedBuilds", () => {
    it("deletes old failed rows", async () => {
      await store.registerBuild({
        id: "img-1",
        repoOwner: "acme",
        repoName: "repo",
        baseBranch: "main",
      });
      await store.markFailed("img-1", "error");

      vi.advanceTimersByTime(86400001); // just over 24 hours

      const count = await store.deleteOldFailedBuilds(86400000);
      expect(count).toBe(1);

      const status = await store.getStatus("acme", "repo");
      expect(status).toHaveLength(0);
    });

    it("does not delete recent failed rows", async () => {
      await store.registerBuild({
        id: "img-1",
        repoOwner: "acme",
        repoName: "repo",
        baseBranch: "main",
      });
      await store.markFailed("img-1", "error");

      vi.advanceTimersByTime(60000); // 1 minute

      const count = await store.deleteOldFailedBuilds(86400000);
      expect(count).toBe(0);
    });

    it("does not delete ready or building rows", async () => {
      await store.registerBuild({
        id: "img-building",
        repoOwner: "acme",
        repoName: "repo",
        baseBranch: "main",
      });

      vi.advanceTimersByTime(86400000);

      const count = await store.deleteOldFailedBuilds(86400000);
      expect(count).toBe(0);
    });
  });
});
