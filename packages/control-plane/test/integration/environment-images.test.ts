/**
 * Environment image lifecycle against real D1 (design §7.3): store state
 * machine (register → ready → supersede → reap), the cron-facing routes
 * (enabled/status/mark-stale/cleanup), the build callbacks with internal
 * HMAC auth and their fail-closed registration, and the secret-change
 * supersede save-hook (§7.4).
 *
 * Builds are seeded via EnvironmentImageStore (or raw SQL when a test needs
 * to control created_at) — actually triggering one needs a live Modal
 * deployment, and the SCM-less harness split is the same as PR-4/PR-8.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import { generateInternalToken } from "../../src/auth/internal";
import { EnvironmentImageStore } from "../../src/db/environment-images";
import { EnvironmentStore } from "../../src/db/environments";
import { computeMembersFingerprint } from "../../src/environment-images/fingerprint";
import { MIN_COMPATIBLE_RUNTIME_VERSION } from "../../src/environment-images/model";
import { cleanD1Tables } from "./cleanup";

const BASE = "https://test.local";
const RUNTIME_VERSION = "v53-list-native-runtime";
const MEMBER_SHAS = [{ repoOwner: "acme", repoName: "web", baseSha: "abc123" }];

async function authHeaders(): Promise<Record<string, string>> {
  const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET!);
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function seedEnvironment(opts?: {
  id?: string;
  name?: string;
  prebuildEnabled?: boolean;
  repositories?: [string, string, number, string][];
}): Promise<string> {
  const store = new EnvironmentStore(env.DB);
  const id = opts?.id ?? `env_${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  await store.create(
    {
      id,
      name: opts?.name ?? `Seeded ${id}`,
      description: null,
      prebuild_enabled: opts?.prebuildEnabled ? 1 : 0,
      created_at: now,
      updated_at: now,
    },
    (opts?.repositories ?? [["acme", "web", 1, "main"]]).map(([o, n, rid, b], position) => ({
      position,
      repo_owner: o,
      repo_name: n,
      repo_id: rid,
      base_branch: b,
    }))
  );
  return id;
}

/** Raw insert when a test needs to control created_at/status/artifact. */
async function seedImageRow(row: {
  id: string;
  environmentId: string;
  status: string;
  providerImageId?: string | null;
  membersFingerprint?: string;
  createdAt?: number;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO environment_images
       (id, environment_id, provider, provider_image_id, members_fingerprint,
        member_shas, runtime_version, status, created_at)
     VALUES (?, ?, 'modal', ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      row.id,
      row.environmentId,
      row.providerImageId ?? null,
      row.membersFingerprint ?? "fp-seeded",
      JSON.stringify(MEMBER_SHAS),
      RUNTIME_VERSION,
      row.status,
      row.createdAt ?? Date.now()
    )
    .run();
}

async function getRow(id: string) {
  return env.DB.prepare("SELECT * FROM environment_images WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
}

describe("Environment images", () => {
  beforeEach(cleanD1Tables);

  describe("EnvironmentImageStore state machine", () => {
    it("registers, marks ready, and supersedes older ready images", async () => {
      const environmentId = await seedEnvironment();
      const store = new EnvironmentImageStore(env.DB);

      await seedImageRow({
        id: "envimg-old",
        environmentId,
        status: "ready",
        providerImageId: "im-old",
        createdAt: Date.now() - 1000,
      });

      await store.registerBuild({
        id: "envimg-new",
        environmentId,
        provider: "modal",
        membersFingerprint: "fp-new",
      });
      expect(await store.getActiveBuild(environmentId, "modal")).toEqual({ id: "envimg-new" });

      const result = await store.tryMarkEnvironmentImageReady(
        "envimg-new",
        "modal",
        "im-new",
        MEMBER_SHAS,
        RUNTIME_VERSION,
        12_500
      );

      expect(result.type).toBe("marked_ready");
      if (result.type !== "marked_ready") throw new Error("unreachable");
      expect(result.supersededImages).toEqual([
        {
          environmentImageId: "envimg-old",
          image: { providerImageId: "im-old", providerSessionId: null },
        },
      ]);

      const readyRow = await getRow("envimg-new");
      expect(readyRow?.status).toBe("ready");
      expect(readyRow?.provider_image_id).toBe("im-new");
      expect(readyRow?.runtime_version).toBe(RUNTIME_VERSION);
      expect(JSON.parse(readyRow?.member_shas as string)).toEqual(MEMBER_SHAS);
      expect(readyRow?.build_duration_seconds).toBe(12.5);
      expect((await getRow("envimg-old"))?.status).toBe("superseded");
      expect(await store.getActiveBuild(environmentId, "modal")).toBeNull();
    });

    it("supersedes a late-finishing build when a newer ready image exists", async () => {
      const environmentId = await seedEnvironment();
      const store = new EnvironmentImageStore(env.DB);

      await seedImageRow({
        id: "envimg-late",
        environmentId,
        status: "building",
        createdAt: Date.now() - 5000,
      });
      await seedImageRow({
        id: "envimg-winner",
        environmentId,
        status: "ready",
        providerImageId: "im-winner",
      });

      const result = await store.tryMarkEnvironmentImageReady(
        "envimg-late",
        "modal",
        "im-late",
        MEMBER_SHAS,
        RUNTIME_VERSION,
        10_000
      );

      expect(result.type).toBe("superseded_by_newer_ready");
      expect((await getRow("envimg-late"))?.status).toBe("superseded");
      // The late build recorded its artifact so the reaper can reclaim it.
      expect((await getRow("envimg-late"))?.provider_image_id).toBe("im-late");
      expect((await getRow("envimg-winner"))?.status).toBe("ready");
    });

    it("supersedeActiveImages flips building and ready rows for the secret-change hook", async () => {
      const environmentId = await seedEnvironment();
      const store = new EnvironmentImageStore(env.DB);
      await seedImageRow({ id: "a-ready", environmentId, status: "ready", providerImageId: "im" });
      await seedImageRow({ id: "a-building", environmentId, status: "building" });
      await seedImageRow({ id: "a-failed", environmentId, status: "failed" });

      const superseded = await store.supersedeActiveImages(environmentId);

      expect(superseded).toBe(2);
      expect((await getRow("a-ready"))?.status).toBe("superseded");
      expect((await getRow("a-building"))?.status).toBe("superseded");
      expect((await getRow("a-failed"))?.status).toBe("failed");
    });

    it("hasReadyImageForFingerprint matches only ready rows with the exact fingerprint", async () => {
      const environmentId = await seedEnvironment();
      const store = new EnvironmentImageStore(env.DB);
      await seedImageRow({
        id: "fp-row",
        environmentId,
        status: "ready",
        providerImageId: "im",
        membersFingerprint: "fp-x",
      });

      expect(await store.hasReadyImageForFingerprint(environmentId, "modal", "fp-x")).toBe(true);
      expect(await store.hasReadyImageForFingerprint(environmentId, "modal", "fp-y")).toBe(false);
    });
  });

  describe("cron-facing routes", () => {
    it("GET /environment-images/enabled returns prebuild-enabled environments with fingerprints", async () => {
      const enabledId = await seedEnvironment({
        prebuildEnabled: true,
        repositories: [
          ["acme", "web", 1, "main"],
          ["acme", "api", 2, "develop"],
        ],
      });
      await seedEnvironment({ prebuildEnabled: false });

      const response = await SELF.fetch(`${BASE}/environment-images/enabled`, {
        headers: await authHeaders(),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        environments: Array<{
          id: string;
          membersFingerprint: string;
          repositories: Array<{ repoOwner: string; repoName: string; baseBranch: string }>;
        }>;
        minRuntimeVersion: number;
      };
      expect(body.minRuntimeVersion).toBe(MIN_COMPATIBLE_RUNTIME_VERSION);
      expect(body.environments).toHaveLength(1);
      expect(body.environments[0].id).toBe(enabledId);
      expect(body.environments[0].repositories).toEqual([
        { repoOwner: "acme", repoName: "web", baseBranch: "main" },
        { repoOwner: "acme", repoName: "api", baseBranch: "develop" },
      ]);
      expect(body.environments[0].membersFingerprint).toBe(
        await computeMembersFingerprint(body.environments[0].repositories)
      );
    });

    it("GET /environment-images/status returns non-superseded rows, filterable by environment", async () => {
      const environmentId = await seedEnvironment();
      const otherId = await seedEnvironment();
      await seedImageRow({ id: "st-ready", environmentId, status: "ready", providerImageId: "im" });
      await seedImageRow({ id: "st-superseded", environmentId, status: "superseded" });
      await seedImageRow({ id: "st-other", environmentId: otherId, status: "building" });

      const all = await SELF.fetch(`${BASE}/environment-images/status`, {
        headers: await authHeaders(),
      });
      const allBody = (await all.json()) as { images: Array<{ id: string }> };
      expect(allBody.images.map((i) => i.id).sort()).toEqual(["st-other", "st-ready"]);

      const filtered = await SELF.fetch(
        `${BASE}/environment-images/status?environment_id=${environmentId}`,
        { headers: await authHeaders() }
      );
      const filteredBody = (await filtered.json()) as { images: Array<{ id: string }> };
      expect(filteredBody.images.map((i) => i.id)).toEqual(["st-ready"]);
    });

    it("POST /environment-images/mark-stale fails old building rows", async () => {
      const environmentId = await seedEnvironment();
      await seedImageRow({
        id: "stale-build",
        environmentId,
        status: "building",
        createdAt: Date.now() - 10_000_000,
      });
      await seedImageRow({ id: "fresh-build", environmentId, status: "building" });

      const response = await SELF.fetch(`${BASE}/environment-images/mark-stale`, {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({ max_age_seconds: 3600 }),
      });

      expect(response.status).toBe(200);
      expect(((await response.json()) as { markedFailed: number }).markedFailed).toBe(1);
      expect((await getRow("stale-build"))?.status).toBe("failed");
      expect((await getRow("fresh-build"))?.status).toBe("building");
    });

    it("POST /environment-images/cleanup deletes old failed rows and reaps artifact-less superseded rows", async () => {
      const environmentId = await seedEnvironment();
      await seedImageRow({
        id: "old-failed",
        environmentId,
        status: "failed",
        createdAt: Date.now() - 100_000_000,
      });
      // Superseded before any artifact was recorded (environment delete or
      // secret change mid-build) — reaped directly.
      await seedImageRow({ id: "bare-superseded", environmentId, status: "superseded" });
      // Superseded with an artifact: reclaiming it needs the provider adapter,
      // which is unconfigured in the test env (no MODAL_WORKSPACE) — the row
      // must survive for a later pass instead of leaking the artifact.
      await seedImageRow({
        id: "artifact-superseded",
        environmentId,
        status: "superseded",
        providerImageId: "im-artifact",
      });

      const response = await SELF.fetch(`${BASE}/environment-images/cleanup`, {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({ max_age_seconds: 86400 }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { deleted: number; reapedSuperseded: number };
      expect(body.deleted).toBe(1);
      expect(body.reapedSuperseded).toBe(1);
      expect(await getRow("old-failed")).toBeNull();
      expect(await getRow("bare-superseded")).toBeNull();
      expect((await getRow("artifact-superseded"))?.status).toBe("superseded");
    });

    it("requires internal auth on cron-facing routes", async () => {
      for (const [method, path] of [
        ["GET", "/environment-images/enabled"],
        ["GET", "/environment-images/status"],
        ["POST", "/environment-images/mark-stale"],
        ["POST", "/environment-images/cleanup"],
        ["POST", "/environment-images/trigger/env_x"],
      ] as const) {
        const response = await SELF.fetch(`${BASE}${path}`, { method });
        expect(response.status, `${method} ${path}`).toBe(401);
      }
    });
  });

  describe("build callbacks", () => {
    async function registerBuild(environmentId: string, buildId: string): Promise<void> {
      await new EnvironmentImageStore(env.DB).registerBuild({
        id: buildId,
        environmentId,
        provider: "modal",
        membersFingerprint: "fp-cb",
      });
    }

    it("POST /environment-images/build-complete registers the image", async () => {
      const environmentId = await seedEnvironment();
      await registerBuild(environmentId, "cb-build");

      const response = await SELF.fetch(`${BASE}/environment-images/build-complete`, {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({
          build_id: "cb-build",
          provider_image_id: "im-cb",
          member_shas: MEMBER_SHAS,
          runtime_version: RUNTIME_VERSION,
          build_duration_seconds: 42.5,
        }),
      });

      expect(response.status).toBe(200);
      const row = await getRow("cb-build");
      expect(row?.status).toBe("ready");
      expect(row?.provider_image_id).toBe("im-cb");
      expect(row?.runtime_version).toBe(RUNTIME_VERSION);
      expect(JSON.parse(row?.member_shas as string)).toEqual(MEMBER_SHAS);
    });

    it("rejects callbacks without internal auth", async () => {
      const environmentId = await seedEnvironment();
      await registerBuild(environmentId, "cb-noauth");

      const response = await SELF.fetch(`${BASE}/environment-images/build-complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          build_id: "cb-noauth",
          provider_image_id: "im",
          member_shas: MEMBER_SHAS,
          runtime_version: RUNTIME_VERSION,
          build_duration_seconds: 1,
        }),
      });

      expect(response.status).toBe(401);
      expect((await getRow("cb-noauth"))?.status).toBe("building");
    });

    it.each([
      ["missing runtime_version", { runtime_version: undefined }],
      ["unparseable runtime_version", { runtime_version: "53-no-prefix" }],
      ["missing member_shas", { member_shas: undefined }],
      ["member_shas entry without baseSha", { member_shas: [{ repoOwner: "a", repoName: "b" }] }],
    ])("fails registration closed on %s", async (_label, overrides) => {
      const environmentId = await seedEnvironment();
      await registerBuild(environmentId, "cb-invalid");

      const response = await SELF.fetch(`${BASE}/environment-images/build-complete`, {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({
          build_id: "cb-invalid",
          provider_image_id: "im",
          member_shas: MEMBER_SHAS,
          runtime_version: RUNTIME_VERSION,
          build_duration_seconds: 1,
          ...overrides,
        }),
      });

      expect(response.status).toBe(400);
      expect((await getRow("cb-invalid"))?.status).toBe("building");
    });

    it("POST /environment-images/build-failed marks the build failed", async () => {
      const environmentId = await seedEnvironment();
      await registerBuild(environmentId, "cb-failed");

      const response = await SELF.fetch(`${BASE}/environment-images/build-failed`, {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({ build_id: "cb-failed", error: "setup.failed: boom" }),
      });

      expect(response.status).toBe(200);
      const row = await getRow("cb-failed");
      expect(row?.status).toBe("failed");
      expect(row?.error_message).toBe("setup.failed: boom");
    });

    it("rejects completion for unknown builds with 409", async () => {
      const response = await SELF.fetch(`${BASE}/environment-images/build-complete`, {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({
          build_id: "cb-unknown",
          provider_image_id: "im",
          member_shas: MEMBER_SHAS,
          runtime_version: RUNTIME_VERSION,
          build_duration_seconds: 1,
        }),
      });

      expect(response.status).toBe(409);
    });
  });

  describe("secret-change save-hook (design §7.4)", () => {
    it("PUT /environments/:id/secrets supersedes live images", async () => {
      const environmentId = await seedEnvironment();
      await seedImageRow({
        id: "sec-ready",
        environmentId,
        status: "ready",
        providerImageId: "im-sec",
      });
      await seedImageRow({ id: "sec-building", environmentId, status: "building" });

      const response = await SELF.fetch(`${BASE}/environments/${environmentId}/secrets`, {
        method: "PUT",
        headers: await authHeaders(),
        body: JSON.stringify({ secrets: { API_KEY: "rotated-value" } }),
      });

      expect(response.status).toBe(200);
      // Both the ready image (revoked value baked in) and the in-flight build
      // (baking the outdated value) are invalidated in the same hook.
      expect((await getRow("sec-ready"))?.status).toBe("superseded");
      expect((await getRow("sec-building"))?.status).toBe("superseded");
    });

    it("DELETE /environments/:id/secrets/:key supersedes live images", async () => {
      const environmentId = await seedEnvironment();
      await seedImageRow({
        id: "del-ready",
        environmentId,
        status: "ready",
        providerImageId: "im-del",
      });
      await SELF.fetch(`${BASE}/environments/${environmentId}/secrets`, {
        method: "PUT",
        headers: await authHeaders(),
        body: JSON.stringify({ secrets: { API_KEY: "v" } }),
      });
      // The PUT above already superseded del-ready; re-seed a fresh ready row
      // to isolate the DELETE hook.
      await seedImageRow({
        id: "del-ready-2",
        environmentId,
        status: "ready",
        providerImageId: "im-del-2",
      });

      const response = await SELF.fetch(`${BASE}/environments/${environmentId}/secrets/API_KEY`, {
        method: "DELETE",
        headers: await authHeaders(),
      });

      expect(response.status).toBe(200);
      expect((await getRow("del-ready-2"))?.status).toBe("superseded");
    });
  });
});
