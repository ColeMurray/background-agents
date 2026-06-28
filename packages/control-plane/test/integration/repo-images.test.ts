import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import { computeHmacHex } from "@open-inspect/shared";
import { generateInternalToken } from "../../src/auth/internal";
import { RepoImageStore } from "../../src/db/repo-images";
import { RepoMetadataStore } from "../../src/db/repo-metadata";
import { handleRequest } from "../../src/router";
import type { Env } from "../../src/types";
import { cleanD1Tables } from "./cleanup";

describe("D1 RepoImageStore", () => {
  let store: RepoImageStore;
  let metadataStore: RepoMetadataStore;

  beforeEach(async () => {
    await cleanD1Tables();
    store = new RepoImageStore(env.DB);
    metadataStore = new RepoMetadataStore(env.DB);
  });

  it("registerBuild creates a building row", async () => {
    await store.registerBuild({
      id: "img-acme-repo-1000",
      repoOwner: "acme",
      repoName: "repo",
      provider: "modal",
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
      provider: "modal",
      provider_image_id: "",
      base_sha: "",
    });
    expect(status[0].created_at).toBeGreaterThan(0);
  });

  it("markBuildReady updates build with provider image details", async () => {
    await metadataStore.setImageBuildEnabled("acme", "repo", true);
    await store.registerBuild({
      id: "img-1",
      repoOwner: "acme",
      repoName: "repo",
      provider: "modal",
      baseBranch: "main",
    });

    const result = await store.markBuildReady("img-1", "modal", "modal-img-abc", "abc123", 42_500);
    expect(result.replacedImageId).toBeNull();

    const ready = await store.getLatestReady("acme", "repo", "modal");
    expect(ready).not.toBeNull();
    expect(ready!.provider_image_id).toBe("modal-img-abc");
    expect(ready!.base_sha).toBe("abc123");
    expect(ready!.build_duration_seconds).toBe(42.5);
    expect(ready!.status).toBe("ready");
  });

  it("markBuildReady replaces previous ready image", async () => {
    await metadataStore.setImageBuildEnabled("acme", "repo", true);
    await store.registerBuild({
      id: "img-old",
      repoOwner: "acme",
      repoName: "repo",
      provider: "modal",
      baseBranch: "main",
    });
    await store.markBuildReady("img-old", "modal", "modal-img-old", "sha-old", 30_000);

    await store.registerBuild({
      id: "img-new",
      repoOwner: "acme",
      repoName: "repo",
      provider: "modal",
      baseBranch: "main",
    });
    const result = await store.markBuildReady(
      "img-new",
      "modal",
      "modal-img-new",
      "sha-new",
      40_000
    );

    expect(result.replacedImageId).toBe("modal-img-old");

    const ready = await store.getLatestReady("acme", "repo", "modal");
    expect(ready!.id).toBe("img-new");

    // Old image row is hidden from normal status while retained for cleanup retry.
    const status = await store.getStatus("acme", "repo");
    const ids = status.map((r) => r.id);
    expect(ids).not.toContain("img-old");

    await expect(store.deleteSupersededImage("img-old")).resolves.toBe(true);
    await expect(store.deleteSupersededImage("img-old")).resolves.toBe(false);
  });

  it("markBuildFailed sets error message", async () => {
    await store.registerBuild({
      id: "img-1",
      repoOwner: "acme",
      repoName: "repo",
      provider: "modal",
      baseBranch: "main",
    });
    await store.markBuildFailed("img-1", "modal", "npm install failed");

    const status = await store.getStatus("acme", "repo");
    expect(status[0].status).toBe("failed");
    expect(status[0].error_message).toBe("npm install failed");
  });

  it("getLatestReady returns null when no ready images", async () => {
    await metadataStore.setImageBuildEnabled("acme", "repo", true);
    const result = await store.getLatestReady("acme", "repo", "modal");
    expect(result).toBeNull();
  });

  it("getLatestReady ignores building and failed images", async () => {
    await metadataStore.setImageBuildEnabled("acme", "repo", true);
    await store.registerBuild({
      id: "img-building",
      repoOwner: "acme",
      repoName: "repo",
      provider: "modal",
      baseBranch: "main",
    });
    await store.registerBuild({
      id: "img-failed",
      repoOwner: "acme",
      repoName: "repo",
      provider: "modal",
      baseBranch: "main",
    });
    await store.markBuildFailed("img-failed", "modal", "error");

    const result = await store.getLatestReady("acme", "repo", "modal");
    expect(result).toBeNull();
  });

  it("getLatestReady is case-insensitive", async () => {
    await metadataStore.setImageBuildEnabled("acme", "repo", true);
    await store.registerBuild({
      id: "img-1",
      repoOwner: "Acme",
      repoName: "Repo",
      provider: "modal",
      baseBranch: "main",
    });
    await store.markBuildReady("img-1", "modal", "modal-img-1", "sha1", 30_000);

    const result = await store.getLatestReady("ACME", "REPO", "modal");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("img-1");
  });

  it("getLatestReady returns null when image_build_enabled is false", async () => {
    await metadataStore.setImageBuildEnabled("acme", "repo", false);
    await store.registerBuild({
      id: "img-1",
      repoOwner: "acme",
      repoName: "repo",
      provider: "modal",
      baseBranch: "main",
    });
    await store.markBuildReady("img-1", "modal", "modal-img-1", "sha1", 30_000);

    const result = await store.getLatestReady("acme", "repo", "modal");
    expect(result).toBeNull();
  });

  it("getLatestReady returns image after re-enabling builds", async () => {
    await metadataStore.setImageBuildEnabled("acme", "repo", true);
    await store.registerBuild({
      id: "img-1",
      repoOwner: "acme",
      repoName: "repo",
      provider: "modal",
      baseBranch: "main",
    });
    await store.markBuildReady("img-1", "modal", "modal-img-1", "sha1", 30_000);

    // Disable — image should not be returned
    await metadataStore.setImageBuildEnabled("acme", "repo", false);
    expect(await store.getLatestReady("acme", "repo", "modal")).toBeNull();

    // Re-enable — same image should be returned immediately
    await metadataStore.setImageBuildEnabled("acme", "repo", true);
    const result = await store.getLatestReady("acme", "repo", "modal");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("img-1");
  });

  it("getStatus returns builds ordered by created_at DESC", async () => {
    await store.registerBuild({
      id: "img-1",
      repoOwner: "acme",
      repoName: "repo",
      provider: "modal",
      baseBranch: "main",
    });
    await store.registerBuild({
      id: "img-2",
      repoOwner: "acme",
      repoName: "repo",
      provider: "modal",
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
      provider: "modal",
      baseBranch: "main",
    });
    await store.registerBuild({
      id: "img-b",
      repoOwner: "acme",
      repoName: "repo-b",
      provider: "modal",
      baseBranch: "main",
    });

    const all = await store.getAllStatus();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it("markStaleBuildsAsFailed marks old building rows", async () => {
    // Insert a row with a very old created_at by using D1 directly
    await env.DB.prepare(
      "INSERT INTO repo_images (id, repo_owner, repo_name, provider, base_branch, provider_image_id, status, base_sha, created_at) VALUES (?, ?, ?, ?, ?, '', 'building', '', ?)"
    )
      .bind("img-stale", "acme", "repo", "modal", "main", Date.now() - 3600000)
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
      "INSERT INTO repo_images (id, repo_owner, repo_name, provider, base_branch, provider_image_id, status, base_sha, error_message, created_at) VALUES (?, ?, ?, ?, ?, '', 'failed', '', 'old error', ?)"
    )
      .bind("img-old-fail", "acme", "repo", "modal", "main", Date.now() - 86400000 - 1000)
      .run();

    const count = await store.deleteOldFailedBuilds(86400000); // 24 hours
    expect(count).toBe(1);

    const status = await store.getStatus("acme", "repo");
    const deleted = status.find((r) => r.id === "img-old-fail");
    expect(deleted).toBeUndefined();
  });

  it("different repos have independent images", async () => {
    await metadataStore.setImageBuildEnabled("acme", "repo-a", true);
    await metadataStore.setImageBuildEnabled("acme", "repo-b", true);
    await store.registerBuild({
      id: "img-a",
      repoOwner: "acme",
      repoName: "repo-a",
      provider: "modal",
      baseBranch: "main",
    });
    await store.markBuildReady("img-a", "modal", "modal-a", "sha-a", 30_000);

    await store.registerBuild({
      id: "img-b",
      repoOwner: "acme",
      repoName: "repo-b",
      provider: "modal",
      baseBranch: "main",
    });
    await store.markBuildReady("img-b", "modal", "modal-b", "sha-b", 40_000);

    const readyA = await store.getLatestReady("acme", "repo-a", "modal");
    const readyB = await store.getLatestReady("acme", "repo-b", "modal");

    expect(readyA!.provider_image_id).toBe("modal-a");
    expect(readyB!.provider_image_id).toBe("modal-b");
  });

  it("getLatestReady filters images by provider", async () => {
    await metadataStore.setImageBuildEnabled("acme", "repo", true);
    await store.registerBuild({
      id: "img-modal",
      repoOwner: "acme",
      repoName: "repo",
      provider: "modal",
      baseBranch: "main",
    });
    await store.markBuildReady("img-modal", "modal", "modal-img", "sha-modal", 30_000);

    await store.registerBuild({
      id: "img-vercel",
      repoOwner: "acme",
      repoName: "repo",
      provider: "vercel",
      baseBranch: "main",
    });
    await store.markBuildReady("img-vercel", "vercel", "vercel-snapshot", "sha-vercel", 40_000);

    const modalImage = await store.getLatestReady("acme", "repo", "modal", "main");
    const vercelImage = await store.getLatestReady("acme", "repo", "vercel", "main");

    expect(modalImage!.provider_image_id).toBe("modal-img");
    expect(vercelImage!.provider_image_id).toBe("vercel-snapshot");
  });
});

// ==================== HTTP Route Tests ====================

const VERCEL_CALLBACK_TOKEN = "a".repeat(64);

async function authHeaders(): Promise<Record<string, string>> {
  const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET!);
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function vercelEnv(): Env {
  return { ...(env as unknown as Env), SANDBOX_PROVIDER: "vercel" };
}

async function repoImageCallbackTokenHash(token: string): Promise<string> {
  return computeHmacHex(`repo-image-callback:${token}`, env.INTERNAL_CALLBACK_SECRET!);
}

describe("Repo image HTTP routes", () => {
  let store: RepoImageStore;
  let metadataStore: RepoMetadataStore;

  beforeEach(async () => {
    await cleanD1Tables();
    store = new RepoImageStore(env.DB);
    metadataStore = new RepoMetadataStore(env.DB);
  });

  it("POST /repo-images/build-complete marks build as ready", async () => {
    await metadataStore.setImageBuildEnabled("acme", "repo", true);
    await store.registerBuild({
      id: "img-test-1",
      repoOwner: "acme",
      repoName: "repo",
      provider: "modal",
      baseBranch: "main",
    });

    const response = await SELF.fetch("https://test.local/repo-images/build-complete", {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({
        build_id: "img-test-1",
        provider_image_id: "modal-img-xyz",
        base_sha: "abc123",
        build_duration_seconds: 45.5,
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json<{ ok: boolean; replacedImageId: string | null }>();
    expect(body.ok).toBe(true);
    expect(body.replacedImageId).toBeNull();

    const ready = await store.getLatestReady("acme", "repo", "modal");
    expect(ready).not.toBeNull();
    expect(ready!.provider_image_id).toBe("modal-img-xyz");
  });

  it("POST /repo-images/build-complete rejects missing callback auth", async () => {
    await store.registerBuild({
      id: "img-auth-required",
      repoOwner: "acme",
      repoName: "repo",
      provider: "modal",
      baseBranch: "main",
    });

    const response = await SELF.fetch("https://test.local/repo-images/build-complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        build_id: "img-auth-required",
        provider_image_id: "modal-img-auth",
      }),
    });

    expect(response.status).toBe(401);
    const status = await store.getStatus("acme", "repo");
    expect(status[0].status).toBe("building");
  });

  it("POST /repo-images/build-complete rejects missing completion metadata", async () => {
    await store.registerBuild({
      id: "img-missing-metadata",
      repoOwner: "acme",
      repoName: "repo",
      provider: "modal",
      baseBranch: "main",
    });

    const response = await SELF.fetch("https://test.local/repo-images/build-complete", {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({
        build_id: "img-missing-metadata",
        provider_image_id: "modal-img-missing-metadata",
      }),
    });

    expect(response.status).toBe(400);
    const body = await response.json<{ error: string }>();
    expect(body.error).toBe("base_sha is required");

    const status = await store.getStatus("acme", "repo");
    expect(status[0].status).toBe("building");
  });

  it("POST /repo-images/build-complete rejects unauthenticated Modal callbacks before parsing body", async () => {
    const response = await SELF.fetch("https://test.local/repo-images/build-complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    expect(response.status).toBe(401);
  });

  it("POST /repo-images/build-failed marks build as failed", async () => {
    await store.registerBuild({
      id: "img-test-2",
      repoOwner: "acme",
      repoName: "repo",
      provider: "modal",
      baseBranch: "main",
    });

    const response = await SELF.fetch("https://test.local/repo-images/build-failed", {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({
        build_id: "img-test-2",
        error: "npm install failed",
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);

    const status = await store.getStatus("acme", "repo");
    const failed = status.find((r) => r.id === "img-test-2");
    expect(failed!.status).toBe("failed");
    expect(failed!.error_message).toBe("npm install failed");
  });

  it("POST /repo-images/build-failed rejects unauthenticated Modal callbacks before parsing body", async () => {
    const response = await SELF.fetch("https://test.local/repo-images/build-failed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    expect(response.status).toBe(401);
  });

  it("POST /repo-images/build-failed accepts Vercel per-build callback auth through the full router", async () => {
    const token = VERCEL_CALLBACK_TOKEN;
    await store.registerBuild({
      id: "img-vercel-failed",
      repoOwner: "acme",
      repoName: "repo",
      provider: "vercel",
      baseBranch: "main",
      callbackTokenHash: await repoImageCallbackTokenHash(token),
      callbackTokenExpiresAt: Date.now() + 60_000,
    });
    await store.bindProviderSession("img-vercel-failed", "vercel", "vercel-session-1");

    const response = await handleRequest(
      new Request("https://test.local/repo-images/build-failed", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          build_id: "img-vercel-failed",
          provider_session_id: "vercel-session-1",
          error: "setup failed",
        }),
      }),
      vercelEnv()
    );

    expect(response.status).toBe(200);
    const status = await store.getStatus("acme", "repo");
    const failed = status.find((row) => row.id === "img-vercel-failed");
    expect(failed!.status).toBe("failed");
    expect(failed!.error_message).toBe("setup failed");
    expect(failed!.callback_token_used_at).toEqual(expect.any(Number));
  });

  it("POST /repo-images/build-failed rejects missing Vercel callback token through the full router", async () => {
    await store.registerBuild({
      id: "img-vercel-missing-token",
      repoOwner: "acme",
      repoName: "repo",
      provider: "vercel",
      baseBranch: "main",
      callbackTokenHash: await repoImageCallbackTokenHash(VERCEL_CALLBACK_TOKEN),
      callbackTokenExpiresAt: Date.now() + 60_000,
    });
    await store.bindProviderSession("img-vercel-missing-token", "vercel", "vercel-session-1");

    const response = await handleRequest(
      new Request("https://test.local/repo-images/build-failed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          build_id: "img-vercel-missing-token",
          provider_session_id: "vercel-session-1",
          error: "setup failed",
        }),
      }),
      vercelEnv()
    );

    expect(response.status).toBe(401);
    const status = await store.getStatus("acme", "repo");
    const build = status.find((row) => row.id === "img-vercel-missing-token");
    expect(build!.status).toBe("building");
    expect(build!.callback_token_used_at).toBeNull();
  });

  it("POST /repo-images/build-failed rejects malformed Vercel callback auth before parsing body", async () => {
    const response = await handleRequest(
      new Request("https://test.local/repo-images/build-failed", {
        method: "POST",
        headers: {
          Authorization: "Bearer not-a-valid-callback-token",
          "Content-Type": "application/json",
        },
        body: "{",
      }),
      vercelEnv()
    );

    expect(response.status).toBe(401);
  });

  it("POST /repo-images/build-failed rejects Vercel callback session mismatch through the full router", async () => {
    const token = VERCEL_CALLBACK_TOKEN;
    await store.registerBuild({
      id: "img-vercel-session-mismatch",
      repoOwner: "acme",
      repoName: "repo",
      provider: "vercel",
      baseBranch: "main",
      callbackTokenHash: await repoImageCallbackTokenHash(token),
      callbackTokenExpiresAt: Date.now() + 60_000,
    });
    await store.bindProviderSession("img-vercel-session-mismatch", "vercel", "vercel-session-1");

    const response = await handleRequest(
      new Request("https://test.local/repo-images/build-failed", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          build_id: "img-vercel-session-mismatch",
          provider_session_id: "other-vercel-session",
          error: "setup failed",
        }),
      }),
      vercelEnv()
    );

    expect(response.status).toBe(401);
    const status = await store.getStatus("acme", "repo");
    const build = status.find((row) => row.id === "img-vercel-session-mismatch");
    expect(build!.status).toBe("building");
    expect(build!.callback_token_used_at).toBeNull();
  });

  it("POST /repo-images/build-failed rejects Vercel callback replay through the full router", async () => {
    const token = VERCEL_CALLBACK_TOKEN;
    await store.registerBuild({
      id: "img-vercel-replay",
      repoOwner: "acme",
      repoName: "repo",
      provider: "vercel",
      baseBranch: "main",
      callbackTokenHash: await repoImageCallbackTokenHash(token),
      callbackTokenExpiresAt: Date.now() + 60_000,
    });
    await store.bindProviderSession("img-vercel-replay", "vercel", "vercel-session-1");

    const makeRequest = () =>
      new Request("https://test.local/repo-images/build-failed", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          build_id: "img-vercel-replay",
          provider_session_id: "vercel-session-1",
          error: "setup failed",
        }),
      });

    const first = await handleRequest(makeRequest(), vercelEnv());
    expect(first.status).toBe(200);

    const replay = await handleRequest(makeRequest(), vercelEnv());
    expect(replay.status).toBe(401);
  });

  it("GET /repo-images/status returns images for a repo", async () => {
    await store.registerBuild({
      id: "img-s1",
      repoOwner: "acme",
      repoName: "repo",
      provider: "modal",
      baseBranch: "main",
    });
    await store.markBuildReady("img-s1", "modal", "modal-img-1", "sha1", 30_000);

    const headers = await authHeaders();
    delete (headers as Record<string, string | undefined>)["Content-Type"];

    const response = await SELF.fetch(
      "https://test.local/repo-images/status?repo_owner=acme&repo_name=repo",
      { headers }
    );

    expect(response.status).toBe(200);
    const body = await response.json<{ images: unknown[] }>();
    expect(body.images.length).toBeGreaterThanOrEqual(1);
  });

  it("POST /repo-images/mark-stale marks old building rows", async () => {
    await env.DB.prepare(
      "INSERT INTO repo_images (id, repo_owner, repo_name, provider, base_branch, provider_image_id, status, base_sha, created_at) VALUES (?, ?, ?, ?, ?, '', 'building', '', ?)"
    )
      .bind("img-stale-route", "acme", "repo", "modal", "main", Date.now() - 3600000)
      .run();

    const response = await SELF.fetch("https://test.local/repo-images/mark-stale", {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ max_age_seconds: 1800 }),
    });

    expect(response.status).toBe(200);
    const body = await response.json<{ ok: boolean; markedFailed: number }>();
    expect(body.ok).toBe(true);
    expect(body.markedFailed).toBeGreaterThanOrEqual(1);
  });

  it("POST /repo-images/cleanup deletes old failed builds", async () => {
    await env.DB.prepare(
      "INSERT INTO repo_images (id, repo_owner, repo_name, provider, base_branch, provider_image_id, status, base_sha, error_message, created_at) VALUES (?, ?, ?, ?, ?, '', 'failed', '', 'old error', ?)"
    )
      .bind("img-cleanup-route", "acme", "repo", "modal", "main", Date.now() - 86400000 - 1000)
      .run();

    const response = await SELF.fetch("https://test.local/repo-images/cleanup", {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ max_age_seconds: 86400 }),
    });

    expect(response.status).toBe(200);
    const body = await response.json<{ ok: boolean; deleted: number }>();
    expect(body.ok).toBe(true);
    expect(body.deleted).toBeGreaterThanOrEqual(1);
  });

  it("GET /repo-images/enabled-repos returns repos with image building enabled", async () => {
    const metadataStore = new RepoMetadataStore(env.DB);
    await metadataStore.setImageBuildEnabled("acme", "repo-a", true);
    await metadataStore.setImageBuildEnabled("acme", "repo-b", false);
    await metadataStore.setImageBuildEnabled("acme", "repo-c", true);

    const headers = await authHeaders();
    delete (headers as Record<string, string | undefined>)["Content-Type"];

    const response = await SELF.fetch("https://test.local/repo-images/enabled-repos", {
      headers,
    });

    expect(response.status).toBe(200);
    const body = await response.json<{
      repos: Array<{ repoOwner: string; repoName: string }>;
    }>();
    expect(body.repos).toHaveLength(2);
    const names = body.repos.map((r) => r.repoName).sort();
    expect(names).toEqual(["repo-a", "repo-c"]);
  });

  it("PUT /repo-images/toggle/:owner/:name enables image build", async () => {
    const response = await SELF.fetch("https://test.local/repo-images/toggle/acme/repo", {
      method: "PUT",
      headers: await authHeaders(),
      body: JSON.stringify({ enabled: true }),
    });

    expect(response.status).toBe(200);
    const body = await response.json<{ ok: boolean; enabled: boolean }>();
    expect(body.ok).toBe(true);
    expect(body.enabled).toBe(true);

    // Verify via enabled-repos endpoint
    const headers = await authHeaders();
    delete (headers as Record<string, string | undefined>)["Content-Type"];
    const enabledResponse = await SELF.fetch("https://test.local/repo-images/enabled-repos", {
      headers,
    });
    const enabledBody = await enabledResponse.json<{
      repos: Array<{ repoOwner: string; repoName: string }>;
    }>();
    const found = enabledBody.repos.find((r) => r.repoOwner === "acme" && r.repoName === "repo");
    expect(found).toBeDefined();
  });

  it("PUT /repo-images/toggle/:owner/:name disables image build", async () => {
    // Enable first
    await SELF.fetch("https://test.local/repo-images/toggle/acme/repo", {
      method: "PUT",
      headers: await authHeaders(),
      body: JSON.stringify({ enabled: true }),
    });

    // Disable
    const response = await SELF.fetch("https://test.local/repo-images/toggle/acme/repo", {
      method: "PUT",
      headers: await authHeaders(),
      body: JSON.stringify({ enabled: false }),
    });

    expect(response.status).toBe(200);
    const body = await response.json<{ ok: boolean; enabled: boolean }>();
    expect(body.ok).toBe(true);
    expect(body.enabled).toBe(false);

    // Verify repo no longer in enabled list
    const headers = await authHeaders();
    delete (headers as Record<string, string | undefined>)["Content-Type"];
    const enabledResponse = await SELF.fetch("https://test.local/repo-images/enabled-repos", {
      headers,
    });
    const enabledBody = await enabledResponse.json<{
      repos: Array<{ repoOwner: string; repoName: string }>;
    }>();
    const found = enabledBody.repos.find((r) => r.repoOwner === "acme" && r.repoName === "repo");
    expect(found).toBeUndefined();
  });

  it("PUT /repo-images/toggle with non-boolean enabled returns 400", async () => {
    const response = await SELF.fetch("https://test.local/repo-images/toggle/acme/repo", {
      method: "PUT",
      headers: await authHeaders(),
      body: JSON.stringify({ enabled: "yes" }),
    });

    expect(response.status).toBe(400);
    const body = await response.json<{ error: string }>();
    expect(body.error).toContain("boolean");
  });

  it("PUT /repo-images/toggle requires auth", async () => {
    const response = await SELF.fetch("https://test.local/repo-images/toggle/acme/repo", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(response.status).toBe(401);
  });

  it("requires auth on all repo-images routes", async () => {
    const response = await SELF.fetch("https://test.local/repo-images/status");
    expect(response.status).toBe(401);
  });

  it("full callback flow: register -> complete -> status shows ready", async () => {
    // 1. Register a build (as if triggered)
    await store.registerBuild({
      id: "img-flow-1",
      repoOwner: "acme",
      repoName: "repo",
      provider: "modal",
      baseBranch: "main",
    });

    // 2. Complete the build via callback
    const completeResponse = await SELF.fetch("https://test.local/repo-images/build-complete", {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({
        build_id: "img-flow-1",
        provider_image_id: "modal-img-flow",
        base_sha: "flow-sha-123",
        build_duration_seconds: 55.5,
      }),
    });
    expect(completeResponse.status).toBe(200);

    // 3. Verify status shows ready
    const headers = await authHeaders();
    delete (headers as Record<string, string | undefined>)["Content-Type"];
    const statusResponse = await SELF.fetch(
      "https://test.local/repo-images/status?repo_owner=acme&repo_name=repo",
      { headers }
    );
    expect(statusResponse.status).toBe(200);
    const statusBody = await statusResponse.json<{
      images: Array<{ id: string; status: string; provider_image_id: string }>;
    }>();
    const readyImage = statusBody.images.find((img) => img.id === "img-flow-1");
    expect(readyImage).toBeDefined();
    expect(readyImage!.status).toBe("ready");
    expect(readyImage!.provider_image_id).toBe("modal-img-flow");
  });
});
