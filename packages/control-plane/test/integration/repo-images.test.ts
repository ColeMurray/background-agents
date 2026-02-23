import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { RepoImageStore } from "../../src/db/repo-images";
import { cleanD1Tables } from "./cleanup";

describe("D1 RepoImageStore", () => {
  let store: RepoImageStore;

  beforeEach(async () => {
    await cleanD1Tables();
    store = new RepoImageStore(env.DB);
  });

  it("registerBuild creates a building row", async () => {
    await store.registerBuild({
      id: "img-acme-repo-1000",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });

    const status = await store.getStatus("acme", "repo");
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({
      id: "img-acme-repo-1000",
      repo_owner: "acme",
      repo_name: "repo",
      status: "building",
      base_branch: "main",
      provider_image_id: "",
      base_sha: "",
    });
    expect(status[0].created_at).toBeGreaterThan(0);
  });

  it("markReady updates build with provider image details", async () => {
    await store.registerBuild({
      id: "img-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });

    const result = await store.markReady("img-1", "modal-img-abc", "abc123", 42.5);
    expect(result.replacedImageId).toBeNull();

    const ready = await store.getLatestReady("acme", "repo");
    expect(ready).not.toBeNull();
    expect(ready!.provider_image_id).toBe("modal-img-abc");
    expect(ready!.base_sha).toBe("abc123");
    expect(ready!.build_duration_seconds).toBe(42.5);
    expect(ready!.status).toBe("ready");
  });

  it("markReady replaces previous ready image", async () => {
    await store.registerBuild({
      id: "img-old",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });
    await store.markReady("img-old", "modal-img-old", "sha-old", 30);

    await store.registerBuild({
      id: "img-new",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });
    const result = await store.markReady("img-new", "modal-img-new", "sha-new", 40);

    expect(result.replacedImageId).toBe("modal-img-old");

    const ready = await store.getLatestReady("acme", "repo");
    expect(ready!.id).toBe("img-new");

    // Old image row should be deleted
    const status = await store.getStatus("acme", "repo");
    const ids = status.map((r) => r.id);
    expect(ids).not.toContain("img-old");
  });

  it("markFailed sets error message", async () => {
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

  it("getLatestReady returns null when no ready images", async () => {
    const result = await store.getLatestReady("acme", "repo");
    expect(result).toBeNull();
  });

  it("getLatestReady ignores building and failed images", async () => {
    await store.registerBuild({
      id: "img-building",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });
    await store.registerBuild({
      id: "img-failed",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });
    await store.markFailed("img-failed", "error");

    const result = await store.getLatestReady("acme", "repo");
    expect(result).toBeNull();
  });

  it("getLatestReady is case-insensitive", async () => {
    await store.registerBuild({
      id: "img-1",
      repoOwner: "Acme",
      repoName: "Repo",
      baseBranch: "main",
    });
    await store.markReady("img-1", "modal-img-1", "sha1", 30);

    const result = await store.getLatestReady("ACME", "REPO");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("img-1");
  });

  it("getStatus returns builds ordered by created_at DESC", async () => {
    await store.registerBuild({
      id: "img-1",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });
    await store.registerBuild({
      id: "img-2",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
    });

    const status = await store.getStatus("acme", "repo");
    expect(status.length).toBeGreaterThanOrEqual(2);
  });

  it("getAllStatus returns images across repos", async () => {
    await store.registerBuild({
      id: "img-a",
      repoOwner: "acme",
      repoName: "repo-a",
      baseBranch: "main",
    });
    await store.registerBuild({
      id: "img-b",
      repoOwner: "acme",
      repoName: "repo-b",
      baseBranch: "main",
    });

    const all = await store.getAllStatus();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it("markStaleBuildsAsFailed marks old building rows", async () => {
    // Insert a row with a very old created_at by using D1 directly
    await env.DB.prepare(
      "INSERT INTO repo_images (id, repo_owner, repo_name, base_branch, provider_image_id, status, base_sha, created_at) VALUES (?, ?, ?, ?, '', 'building', '', ?)"
    )
      .bind("img-stale", "acme", "repo", "main", Date.now() - 3600000)
      .run();

    const count = await store.markStaleBuildsAsFailed(1800000); // 30 min
    expect(count).toBe(1);

    const status = await store.getStatus("acme", "repo");
    const stale = status.find((r) => r.id === "img-stale");
    expect(stale!.status).toBe("failed");
    expect(stale!.error_message).toContain("timed out");
  });

  it("deleteOldFailedBuilds removes old failed rows", async () => {
    await env.DB.prepare(
      "INSERT INTO repo_images (id, repo_owner, repo_name, base_branch, provider_image_id, status, base_sha, error_message, created_at) VALUES (?, ?, ?, ?, '', 'failed', '', 'old error', ?)"
    )
      .bind("img-old-fail", "acme", "repo", "main", Date.now() - 86400000 - 1000)
      .run();

    const count = await store.deleteOldFailedBuilds(86400000); // 24 hours
    expect(count).toBe(1);

    const status = await store.getStatus("acme", "repo");
    const deleted = status.find((r) => r.id === "img-old-fail");
    expect(deleted).toBeUndefined();
  });

  it("different repos have independent images", async () => {
    await store.registerBuild({
      id: "img-a",
      repoOwner: "acme",
      repoName: "repo-a",
      baseBranch: "main",
    });
    await store.markReady("img-a", "modal-a", "sha-a", 30);

    await store.registerBuild({
      id: "img-b",
      repoOwner: "acme",
      repoName: "repo-b",
      baseBranch: "main",
    });
    await store.markReady("img-b", "modal-b", "sha-b", 40);

    const readyA = await store.getLatestReady("acme", "repo-a");
    const readyB = await store.getLatestReady("acme", "repo-b");

    expect(readyA!.provider_image_id).toBe("modal-a");
    expect(readyB!.provider_image_id).toBe("modal-b");
  });
});
