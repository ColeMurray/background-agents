import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepoImageStore } from "./repo-images";

type RepoImageRow = {
  id: string;
  repo_owner: string;
  repo_name: string;
  provider: string;
  provider_session_id: string | null;
  provider_image_id: string;
  base_sha: string;
  base_branch: string;
  status: string;
  build_duration_seconds: number | null;
  error_message: string | null;
  callback_token_hash: string | null;
  callback_token_expires_at: number | null;
  callback_token_used_at: number | null;
  created_at: number;
};

const QUERY_PATTERNS = {
  INSERT_BUILD: /^INSERT INTO repo_images/,
  SELECT_BY_ID:
    /^SELECT repo_owner, repo_name, provider, base_branch FROM repo_images WHERE id = \? AND provider = \? AND status = 'building'$/,
  UPDATE_PROVIDER_SESSION:
    /^UPDATE repo_images SET provider_session_id = \? WHERE id = \? AND provider = \? AND status = 'building'$/,
  SELECT_CALLBACK_BUILD:
    /^SELECT id, provider, provider_session_id, status, callback_token_hash, callback_token_expires_at, callback_token_used_at FROM repo_images WHERE id = \? AND provider = \?$/,
  UPDATE_CALLBACK_USED:
    /^UPDATE repo_images SET callback_token_used_at = \? WHERE id = \? AND provider = \? AND status = 'building' AND callback_token_hash = \? AND callback_token_used_at IS NULL$/,
  SELECT_READY_FOR_REPO:
    /^SELECT id, provider_image_id FROM repo_images WHERE repo_owner = \? AND repo_name = \? AND provider = \? AND base_branch = \? AND status = 'ready'$/,
  UPDATE_READY:
    /^UPDATE repo_images SET status = 'ready', provider_image_id = \?, base_sha = \?, build_duration_seconds = \? WHERE id = \? AND provider = \? AND status = 'building'$/,
  DELETE_BY_ID: /^DELETE FROM repo_images WHERE id = \?$/,
  UPDATE_FAILED:
    /^UPDATE repo_images SET status = 'failed', error_message = \? WHERE id = \? AND provider = \? AND status = 'building'$/,
  SELECT_LATEST_READY:
    /^SELECT ri\.\* FROM repo_images ri INNER JOIN repo_metadata rm ON ri\.repo_owner = rm\.repo_owner AND ri\.repo_name = rm\.repo_name WHERE ri\.repo_owner = \? AND ri\.repo_name = \?.*ORDER BY ri\.created_at DESC LIMIT 1$/,
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
  private repoMetadata = new Map<string, { image_build_enabled: number }>();

  setImageBuildEnabled(repoOwner: string, repoName: string, enabled: boolean) {
    this.repoMetadata.set(`${repoOwner.toLowerCase()}/${repoName.toLowerCase()}`, {
      image_build_enabled: enabled ? 1 : 0,
    });
  }

  private isImageBuildEnabled(repoOwner: string, repoName: string): boolean {
    const meta = this.repoMetadata.get(`${repoOwner.toLowerCase()}/${repoName.toLowerCase()}`);
    return meta?.image_build_enabled === 1;
  }

  prepare(query: string) {
    return new FakePreparedStatement(this, query);
  }

  first(query: string, args: unknown[]): Partial<RepoImageRow> | null {
    const normalized = normalizeQuery(query);

    if (QUERY_PATTERNS.SELECT_BY_ID.test(normalized)) {
      const [id, provider] = args as [string, string];
      const row = this.rows.get(id);
      return row && row.provider === provider && row.status === "building"
        ? {
            repo_owner: row.repo_owner,
            repo_name: row.repo_name,
            provider: row.provider,
            base_branch: row.base_branch,
          }
        : null;
    }

    if (QUERY_PATTERNS.SELECT_CALLBACK_BUILD.test(normalized)) {
      const [id, provider] = args as [string, string];
      const row = this.rows.get(id);
      return row && row.provider === provider
        ? {
            id: row.id,
            provider: row.provider,
            provider_session_id: row.provider_session_id,
            status: row.status,
            callback_token_hash: row.callback_token_hash,
            callback_token_expires_at: row.callback_token_expires_at,
            callback_token_used_at: row.callback_token_used_at,
          }
        : null;
    }

    if (QUERY_PATTERNS.SELECT_READY_FOR_REPO.test(normalized)) {
      const [owner, name, provider, branch] = args as [string, string, string, string];
      for (const row of this.rows.values()) {
        if (
          row.repo_owner === owner &&
          row.repo_name === name &&
          row.provider === provider &&
          row.base_branch === branch &&
          row.status === "ready"
        ) {
          return { id: row.id, provider_image_id: row.provider_image_id };
        }
      }
      return null;
    }

    if (QUERY_PATTERNS.SELECT_LATEST_READY.test(normalized)) {
      const [owner, name, ...rest] = args as string[];
      let branch: string | undefined;
      let provider: string | undefined;
      if (normalized.includes("ri.base_branch = ?")) {
        branch = rest.shift();
      }
      if (normalized.includes("ri.provider = ?")) {
        provider = rest.shift();
      }
      if (!this.isImageBuildEnabled(owner, name)) return null;
      let latest: RepoImageRow | null = null;
      for (const row of this.rows.values()) {
        if (
          row.repo_owner === owner &&
          row.repo_name === name &&
          (!branch || row.base_branch === branch) &&
          (!provider || row.provider === provider) &&
          row.status === "ready"
        ) {
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
      const [
        id,
        owner,
        name,
        provider,
        branch,
        callbackTokenHash,
        callbackTokenExpiresAt,
        createdAt,
      ] = args as [string, string, string, string, string, string | null, number | null, number];
      this.rows.set(id, {
        id,
        repo_owner: owner,
        repo_name: name,
        provider,
        provider_session_id: null,
        base_branch: branch,
        provider_image_id: "",
        status: "building",
        base_sha: "",
        build_duration_seconds: null,
        error_message: null,
        callback_token_hash: callbackTokenHash,
        callback_token_expires_at: callbackTokenExpiresAt,
        callback_token_used_at: null,
        created_at: createdAt,
      });
      return { meta: { changes: 1 } };
    }

    if (QUERY_PATTERNS.UPDATE_PROVIDER_SESSION.test(normalized)) {
      const [providerSessionId, id, provider] = args as [string, string, string];
      const row = this.rows.get(id);
      if (row && row.provider === provider && row.status === "building") {
        row.provider_session_id = providerSessionId;
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }

    if (QUERY_PATTERNS.UPDATE_CALLBACK_USED.test(normalized)) {
      const [usedAt, id, provider, tokenHash] = args as [number, string, string, string];
      const row = this.rows.get(id);
      if (
        row &&
        row.provider === provider &&
        row.status === "building" &&
        row.callback_token_hash === tokenHash &&
        row.callback_token_used_at === null
      ) {
        row.callback_token_used_at = usedAt;
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }

    if (QUERY_PATTERNS.UPDATE_READY.test(normalized)) {
      const [providerImageId, baseSha, buildDuration, id, provider] = args as [
        string,
        string,
        number,
        string,
        string,
      ];
      const row = this.rows.get(id);
      if (row && row.provider === provider && row.status === "building") {
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
      const [error, id, provider] = args as [string, string, string];
      const row = this.rows.get(id);
      if (row && row.provider === provider && row.status === "building") {
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
        provider: "modal",
        baseBranch: "main",
      });

      const status = await store.getStatus("acme", "repo");
      expect(status).toHaveLength(1);
      expect(status[0].status).toBe("building");
      expect(status[0].repo_owner).toBe("acme");
      expect(status[0].repo_name).toBe("repo");
      expect(status[0].provider).toBe("modal");
      expect(status[0].provider_image_id).toBe("");
      expect(status[0].base_sha).toBe("");
    });

    it("stores the requested provider", async () => {
      await store.registerBuild({
        id: "img-vercel",
        repoOwner: "acme",
        repoName: "repo",
        provider: "vercel",
        baseBranch: "main",
      });

      const status = await store.getStatus("acme", "repo");
      expect(status[0].provider).toBe("vercel");
    });

    it("normalizes owner and name to lowercase", async () => {
      await store.registerBuild({
        id: "img-1",
        repoOwner: "ACME",
        repoName: "MyRepo",
        provider: "modal",
        baseBranch: "main",
      });

      const status = await store.getStatus("acme", "myrepo");
      expect(status).toHaveLength(1);
      expect(status[0].repo_owner).toBe("acme");
      expect(status[0].repo_name).toBe("myrepo");
    });
  });

  describe("Vercel callback binding", () => {
    it("binds a provider session to a building Vercel build", async () => {
      await store.registerBuild({
        id: "img-vercel",
        repoOwner: "acme",
        repoName: "repo",
        provider: "vercel",
        baseBranch: "main",
        callbackTokenHash: "token-hash",
        callbackTokenExpiresAt: Date.now() + 60_000,
      });

      await expect(
        store.bindProviderSession("img-vercel", "vercel", "vercel-session-1")
      ).resolves.toBe(true);

      const status = await store.getStatus("acme", "repo");
      expect(status[0].provider_session_id).toBe("vercel-session-1");
    });

    it("consumes callback tokens once and rejects replays", async () => {
      const now = Date.now();
      await store.registerBuild({
        id: "img-vercel",
        repoOwner: "acme",
        repoName: "repo",
        provider: "vercel",
        baseBranch: "main",
        callbackTokenHash: "token-hash",
        callbackTokenExpiresAt: now + 60_000,
      });
      await store.bindProviderSession("img-vercel", "vercel", "vercel-session-1");

      const consumed = await store.consumeCallbackToken({
        buildId: "img-vercel",
        provider: "vercel",
        providerSessionId: "vercel-session-1",
        tokenHash: "token-hash",
        now,
      });
      expect(consumed).toEqual({
        id: "img-vercel",
        provider: "vercel",
        provider_session_id: "vercel-session-1",
      });

      const replay = await store.consumeCallbackToken({
        buildId: "img-vercel",
        provider: "vercel",
        providerSessionId: "vercel-session-1",
        tokenHash: "token-hash",
        now,
      });
      expect(replay).toBeNull();
    });

    it("rejects callback tokens for a mismatched provider session", async () => {
      const now = Date.now();
      await store.registerBuild({
        id: "img-vercel",
        repoOwner: "acme",
        repoName: "repo",
        provider: "vercel",
        baseBranch: "main",
        callbackTokenHash: "token-hash",
        callbackTokenExpiresAt: now + 60_000,
      });
      await store.bindProviderSession("img-vercel", "vercel", "vercel-session-1");

      await expect(
        store.consumeCallbackToken({
          buildId: "img-vercel",
          provider: "vercel",
          providerSessionId: "other-session",
          tokenHash: "token-hash",
          now,
        })
      ).resolves.toBeNull();
    });
  });

  describe("markReady", () => {
    it("updates build to ready with provider image details", async () => {
      db.setImageBuildEnabled("acme", "repo", true);
      await store.registerBuild({
        id: "img-1",
        repoOwner: "acme",
        repoName: "repo",
        provider: "modal",
        baseBranch: "main",
      });

      const result = await store.markReady("img-1", "modal", "modal-img-abc", "sha123", 45.2);

      expect(result.replacedImageId).toBeNull();

      const ready = await store.getLatestReady("acme", "repo", "modal");
      expect(ready).not.toBeNull();
      expect(ready!.provider_image_id).toBe("modal-img-abc");
      expect(ready!.base_sha).toBe("sha123");
      expect(ready!.build_duration_seconds).toBe(45.2);
      expect(ready!.status).toBe("ready");
    });

    it("replaces previous ready image and returns its ID", async () => {
      db.setImageBuildEnabled("acme", "repo", true);
      await store.registerBuild({
        id: "img-old",
        repoOwner: "acme",
        repoName: "repo",
        provider: "modal",
        baseBranch: "main",
      });
      await store.markReady("img-old", "modal", "modal-img-old", "sha-old", 30);

      vi.advanceTimersByTime(60000);

      await store.registerBuild({
        id: "img-new",
        repoOwner: "acme",
        repoName: "repo",
        provider: "modal",
        baseBranch: "main",
      });
      const result = await store.markReady("img-new", "modal", "modal-img-new", "sha-new", 40);

      expect(result.replacedImageId).toBe("modal-img-old");

      const ready = await store.getLatestReady("acme", "repo", "modal");
      expect(ready).not.toBeNull();
      expect(ready!.id).toBe("img-new");
      expect(ready!.provider_image_id).toBe("modal-img-new");
    });

    it("returns null replacedImageId when no previous ready image", async () => {
      await store.registerBuild({
        id: "img-1",
        repoOwner: "acme",
        repoName: "repo",
        provider: "modal",
        baseBranch: "main",
      });

      const result = await store.markReady("img-1", "modal", "modal-img-1", "sha1", 20);
      expect(result.replacedImageId).toBeNull();
    });

    it("returns null for unknown buildId", async () => {
      const result = await store.markReady("nonexistent", "modal", "img", "sha", 10);
      expect(result.replacedImageId).toBeNull();
    });

    it("only replaces a previous ready image for the same provider", async () => {
      db.setImageBuildEnabled("acme", "repo", true);
      await store.registerBuild({
        id: "img-modal",
        repoOwner: "acme",
        repoName: "repo",
        provider: "modal",
        baseBranch: "main",
      });
      await store.markReady("img-modal", "modal", "modal-img", "sha-modal", 30);

      vi.advanceTimersByTime(1000);

      await store.registerBuild({
        id: "img-vercel",
        repoOwner: "acme",
        repoName: "repo",
        provider: "vercel",
        baseBranch: "main",
      });
      const result = await store.markReady(
        "img-vercel",
        "vercel",
        "vercel-snapshot",
        "sha-vercel",
        40
      );

      expect(result.replacedImageId).toBeNull();

      const modalReady = await store.getLatestReady("acme", "repo", "modal", "main");
      const vercelReady = await store.getLatestReady("acme", "repo", "vercel", "main");
      expect(modalReady!.provider_image_id).toBe("modal-img");
      expect(vercelReady!.provider_image_id).toBe("vercel-snapshot");
    });
  });

  describe("markFailed", () => {
    it("sets error message and failed status", async () => {
      await store.registerBuild({
        id: "img-1",
        repoOwner: "acme",
        repoName: "repo",
        provider: "modal",
        baseBranch: "main",
      });

      await store.markFailed("img-1", "modal", "npm install failed");

      const status = await store.getStatus("acme", "repo");
      expect(status[0].status).toBe("failed");
      expect(status[0].error_message).toBe("npm install failed");
    });
  });

  describe("getLatestReady", () => {
    it("returns null when no ready images exist", async () => {
      db.setImageBuildEnabled("acme", "repo", true);
      const result = await store.getLatestReady("acme", "repo", "modal");
      expect(result).toBeNull();
    });

    it("returns null when only building/failed images exist", async () => {
      db.setImageBuildEnabled("acme", "repo", true);
      await store.registerBuild({
        id: "img-1",
        repoOwner: "acme",
        repoName: "repo",
        provider: "modal",
        baseBranch: "main",
      });

      const result = await store.getLatestReady("acme", "repo", "modal");
      expect(result).toBeNull();
    });

    it("returns the most recent ready image", async () => {
      db.setImageBuildEnabled("acme", "repo", true);
      await store.registerBuild({
        id: "img-1",
        repoOwner: "acme",
        repoName: "repo",
        provider: "modal",
        baseBranch: "main",
      });
      await store.markReady("img-1", "modal", "modal-img-1", "sha1", 30);

      const result = await store.getLatestReady("acme", "repo", "modal");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("img-1");
      expect(result!.provider_image_id).toBe("modal-img-1");
    });

    it("returns null when image_build_enabled is false", async () => {
      db.setImageBuildEnabled("acme", "repo", false);
      await store.registerBuild({
        id: "img-1",
        repoOwner: "acme",
        repoName: "repo",
        provider: "modal",
        baseBranch: "main",
      });
      await store.markReady("img-1", "modal", "modal-img-1", "sha1", 30);

      const result = await store.getLatestReady("acme", "repo", "modal");
      expect(result).toBeNull();
    });

    it("returns null when no repo_metadata row exists", async () => {
      // No setImageBuildEnabled call — simulates repo with no metadata
      await store.registerBuild({
        id: "img-1",
        repoOwner: "acme",
        repoName: "repo",
        provider: "modal",
        baseBranch: "main",
      });
      await store.markReady("img-1", "modal", "modal-img-1", "sha1", 30);

      const result = await store.getLatestReady("acme", "repo", "modal");
      expect(result).toBeNull();
    });

    it("is case-insensitive for repo owner and name", async () => {
      db.setImageBuildEnabled("acme", "repo", true);
      await store.registerBuild({
        id: "img-1",
        repoOwner: "acme",
        repoName: "repo",
        provider: "modal",
        baseBranch: "main",
      });
      await store.markReady("img-1", "modal", "modal-img-1", "sha1", 30);

      const result = await store.getLatestReady("ACME", "REPO", "modal");
      expect(result).not.toBeNull();
    });

    it("filters by baseBranch when provided", async () => {
      db.setImageBuildEnabled("acme", "repo", true);
      await store.registerBuild({
        id: "img-main",
        repoOwner: "acme",
        repoName: "repo",
        provider: "modal",
        baseBranch: "main",
      });
      await store.markReady("img-main", "modal", "modal-img-main", "sha-main", 30);

      vi.advanceTimersByTime(1000);

      await store.registerBuild({
        id: "img-dev",
        repoOwner: "acme",
        repoName: "repo",
        provider: "modal",
        baseBranch: "develop",
      });
      await store.markReady("img-dev", "modal", "modal-img-dev", "sha-dev", 25);

      // Without branch filter: returns most recent (develop)
      const anyBranch = await store.getLatestReady("acme", "repo", "modal");
      expect(anyBranch).not.toBeNull();
      expect(anyBranch!.id).toBe("img-dev");

      // With branch filter: returns the matching branch only
      const mainOnly = await store.getLatestReady("acme", "repo", "modal", "main");
      expect(mainOnly).not.toBeNull();
      expect(mainOnly!.id).toBe("img-main");
      expect(mainOnly!.base_branch).toBe("main");

      const devOnly = await store.getLatestReady("acme", "repo", "modal", "develop");
      expect(devOnly).not.toBeNull();
      expect(devOnly!.id).toBe("img-dev");

      // No image for this branch
      const staging = await store.getLatestReady("acme", "repo", "modal", "staging");
      expect(staging).toBeNull();
    });

    it("filters by provider", async () => {
      db.setImageBuildEnabled("acme", "repo", true);
      await store.registerBuild({
        id: "img-modal",
        repoOwner: "acme",
        repoName: "repo",
        provider: "modal",
        baseBranch: "main",
      });
      await store.markReady("img-modal", "modal", "modal-img", "sha-modal", 30);

      vi.advanceTimersByTime(1000);

      await store.registerBuild({
        id: "img-vercel",
        repoOwner: "acme",
        repoName: "repo",
        provider: "vercel",
        baseBranch: "main",
      });
      await store.markReady("img-vercel", "vercel", "vercel-snapshot", "sha-vercel", 40);

      const modalImage = await store.getLatestReady("acme", "repo", "modal");
      const vercelImage = await store.getLatestReady("acme", "repo", "vercel");
      expect(modalImage!.provider_image_id).toBe("modal-img");
      expect(vercelImage!.provider_image_id).toBe("vercel-snapshot");
    });

    it("does not return a newer image from another provider", async () => {
      db.setImageBuildEnabled("acme", "repo", true);
      await store.registerBuild({
        id: "img-vercel",
        repoOwner: "acme",
        repoName: "repo",
        provider: "vercel",
        baseBranch: "main",
      });
      await store.markReady("img-vercel", "vercel", "vercel-snapshot", "sha-vercel", 40);

      vi.advanceTimersByTime(1000);

      await store.registerBuild({
        id: "img-modal",
        repoOwner: "acme",
        repoName: "repo",
        provider: "modal",
        baseBranch: "main",
      });
      await store.markReady("img-modal", "modal", "modal-img", "sha-modal", 30);

      const vercelImage = await store.getLatestReady("acme", "repo", "vercel");
      expect(vercelImage!.provider_image_id).toBe("vercel-snapshot");
    });
  });

  describe("getLatestReadyForAnyProvider", () => {
    it("returns the latest ready image across providers explicitly", async () => {
      db.setImageBuildEnabled("acme", "repo", true);
      await store.registerBuild({
        id: "img-vercel",
        repoOwner: "acme",
        repoName: "repo",
        provider: "vercel",
        baseBranch: "main",
      });
      await store.markReady("img-vercel", "vercel", "vercel-snapshot", "sha-vercel", 40);

      vi.advanceTimersByTime(1000);

      await store.registerBuild({
        id: "img-modal",
        repoOwner: "acme",
        repoName: "repo",
        provider: "modal",
        baseBranch: "main",
      });
      await store.markReady("img-modal", "modal", "modal-img", "sha-modal", 30);

      const latest = await store.getLatestReadyForAnyProvider("acme", "repo");
      expect(latest!.provider_image_id).toBe("modal-img");
      expect(latest!.provider).toBe("modal");
    });
  });

  describe("markReady branch isolation", () => {
    it("only replaces the previous ready image on the same branch", async () => {
      db.setImageBuildEnabled("acme", "repo", true);
      // Build and mark ready on main
      await store.registerBuild({
        id: "img-main",
        repoOwner: "acme",
        repoName: "repo",
        provider: "modal",
        baseBranch: "main",
      });
      await store.markReady("img-main", "modal", "modal-img-main", "sha-main", 30);

      vi.advanceTimersByTime(1000);

      // Build and mark ready on develop — should NOT replace main's image
      await store.registerBuild({
        id: "img-dev",
        repoOwner: "acme",
        repoName: "repo",
        provider: "modal",
        baseBranch: "develop",
      });
      const result = await store.markReady("img-dev", "modal", "modal-img-dev", "sha-dev", 25);

      // No replacement since no previous ready image on "develop"
      expect(result.replacedImageId).toBeNull();

      // main image should still be intact
      const mainImage = await store.getLatestReady("acme", "repo", "modal", "main");
      expect(mainImage).not.toBeNull();
      expect(mainImage!.id).toBe("img-main");
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
        provider: "modal",
        baseBranch: "main",
      });

      vi.advanceTimersByTime(60000);

      await store.registerBuild({
        id: "img-2",
        repoOwner: "acme",
        repoName: "repo",
        provider: "modal",
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
        provider: "modal",
        baseBranch: "main",
      });
      await store.registerBuild({
        id: "img-2",
        repoOwner: "acme",
        repoName: "repo-b",
        provider: "modal",
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
        provider: "modal",
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
        provider: "modal",
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
        provider: "modal",
        baseBranch: "main",
      });
      await store.markReady("img-ready", "modal", "modal-img", "sha1", 30);

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
        provider: "modal",
        baseBranch: "main",
      });
      await store.markFailed("img-1", "modal", "error");

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
        provider: "modal",
        baseBranch: "main",
      });
      await store.markFailed("img-1", "modal", "error");

      vi.advanceTimersByTime(60000); // 1 minute

      const count = await store.deleteOldFailedBuilds(86400000);
      expect(count).toBe(0);
    });

    it("does not delete ready or building rows", async () => {
      await store.registerBuild({
        id: "img-building",
        repoOwner: "acme",
        repoName: "repo",
        provider: "modal",
        baseBranch: "main",
      });

      vi.advanceTimersByTime(86400000);

      const count = await store.deleteOldFailedBuilds(86400000);
      expect(count).toBe(0);
    });
  });
});
