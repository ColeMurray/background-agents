/**
 * Image-build lifecycle against real D1: store state machine (register →
 * ready → supersede → reap), the cron-facing routes (enabled/status/
 * mark-stale/cleanup) on both the unified paths and their legacy
 * /environment-images aliases, the build callbacks with internal HMAC auth
 * and their fail-closed registration, and the secret-change supersede
 * save-hook.
 *
 * Builds are seeded via ImageBuildStore (or raw SQL when a test needs to
 * control created_at) — actually triggering one needs a live Modal
 * deployment, and the SCM-less harness split is the same as PR-4/PR-8.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import { generateInternalToken } from "../../src/auth/internal";
import { ImageBuildStore } from "../../src/db/image-builds";
import { EnvironmentStore } from "../../src/db/environments";
import { computeRepositoriesFingerprint } from "../../src/image-builds/fingerprint";
import { MIN_COMPATIBLE_RUNTIME_VERSION, type ImageBuildScope } from "../../src/image-builds/model";
import { resolveScopeEnabled } from "../../src/image-builds/scope";
import { cleanD1Tables } from "./cleanup";

const BASE = "https://test.local";
const RUNTIME_VERSION = "v53-list-native-runtime";
const REPOSITORY_SHAS = [{ repoOwner: "acme", repoName: "web", baseSha: "abc123" }];

function environmentScope(id: string): ImageBuildScope {
  return { kind: "environment", id };
}

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
      channel_associations: null,
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
  provider?: string;
  providerImageId?: string | null;
  repositoriesFingerprint?: string;
  createdAt?: number;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO image_builds
       (id, scope_kind, scope_id, provider, provider_image_id, repositories_fingerprint,
        repository_shas, runtime_version, status, created_at)
     VALUES (?, 'environment', ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      row.id,
      row.environmentId,
      row.provider ?? "modal",
      row.providerImageId ?? null,
      row.repositoriesFingerprint ?? "fp-seeded",
      JSON.stringify(REPOSITORY_SHAS),
      RUNTIME_VERSION,
      row.status,
      row.createdAt ?? Date.now()
    )
    .run();
}

async function getRow(id: string) {
  return env.DB.prepare("SELECT * FROM image_builds WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
}

/**
 * The spawn-selection path as the Durable Object composes it: the scope
 * resolver answers enablement (and entity existence), then the store serves
 * the plain row read.
 */
async function selectForSpawn(environmentId: string, provider: "modal" | "vercel") {
  const scope = environmentScope(environmentId);
  if (!(await resolveScopeEnabled(env.DB, scope))) return null;
  return new ImageBuildStore(env.DB).getLatestReadyForSpawn(scope, provider);
}

describe("Image builds", () => {
  beforeEach(cleanD1Tables);

  describe("ImageBuildStore state machine", () => {
    it("registers, marks ready, and supersedes older ready images", async () => {
      const environmentId = await seedEnvironment();
      const store = new ImageBuildStore(env.DB);

      await seedImageRow({
        id: "imgb-old",
        environmentId,
        status: "ready",
        providerImageId: "im-old",
        createdAt: Date.now() - 1000,
      });

      await store.registerBuild({
        id: "imgb-new",
        scope: environmentScope(environmentId),
        provider: "modal",
        repositoriesFingerprint: "fp-new",
      });
      expect(await store.getActiveBuild(environmentScope(environmentId), "modal")).toEqual({
        id: "imgb-new",
      });

      const result = await store.tryMarkImageBuildReady(
        "imgb-new",
        "modal",
        "im-new",
        REPOSITORY_SHAS,
        RUNTIME_VERSION,
        12_500
      );

      expect(result.type).toBe("marked_ready");
      if (result.type !== "marked_ready") throw new Error("unreachable");
      expect(result.supersededImages).toEqual([
        {
          imageBuildId: "imgb-old",
          image: { providerImageId: "im-old", providerSessionId: null },
        },
      ]);

      const readyRow = await getRow("imgb-new");
      expect(readyRow?.status).toBe("ready");
      expect(readyRow?.scope_kind).toBe("environment");
      expect(readyRow?.scope_id).toBe(environmentId);
      expect(readyRow?.provider_image_id).toBe("im-new");
      expect(readyRow?.runtime_version).toBe(RUNTIME_VERSION);
      expect(JSON.parse(readyRow?.repository_shas as string)).toEqual(REPOSITORY_SHAS);
      expect(readyRow?.build_duration_seconds).toBe(12.5);
      expect((await getRow("imgb-old"))?.status).toBe("superseded");
      expect(await store.getActiveBuild(environmentScope(environmentId), "modal")).toBeNull();
    });

    it("supersedes a late-finishing build when a newer ready image exists", async () => {
      const environmentId = await seedEnvironment();
      const store = new ImageBuildStore(env.DB);

      await seedImageRow({
        id: "imgb-late",
        environmentId,
        status: "building",
        createdAt: Date.now() - 5000,
      });
      await seedImageRow({
        id: "imgb-winner",
        environmentId,
        status: "ready",
        providerImageId: "im-winner",
      });

      const result = await store.tryMarkImageBuildReady(
        "imgb-late",
        "modal",
        "im-late",
        REPOSITORY_SHAS,
        RUNTIME_VERSION,
        10_000
      );

      expect(result.type).toBe("superseded_by_newer_ready");
      expect((await getRow("imgb-late"))?.status).toBe("superseded");
      // The late build recorded its artifact so the reaper can reclaim it.
      expect((await getRow("imgb-late"))?.provider_image_id).toBe("im-late");
      expect((await getRow("imgb-winner"))?.status).toBe("ready");
    });

    it("registerBuild admits exactly one in-flight build per scope/provider", async () => {
      const environmentId = await seedEnvironment();
      const store = new ImageBuildStore(env.DB);
      const build = (id: string) => ({
        id,
        scope: environmentScope(environmentId),
        provider: "modal" as const,
        repositoriesFingerprint: "fp-race",
      });

      expect(await store.registerBuild(build("race-a"))).toBe(true);
      // Concurrent trigger racing past the getActiveBuild read: the INSERT's
      // NOT EXISTS guard is the authoritative gate.
      expect(await store.registerBuild(build("race-b"))).toBe(false);
      expect(await getRow("race-b")).toBeNull();

      // Out-of-band supersede (secret change) releases the slot so the
      // corrective rebuild can register.
      await store.supersedeActiveImages(environmentScope(environmentId));
      expect(await store.registerBuild(build("race-c"))).toBe(true);
    });

    it("supersedeActiveImages flips building and ready rows for the secret-change hook", async () => {
      const environmentId = await seedEnvironment();
      const store = new ImageBuildStore(env.DB);
      await seedImageRow({ id: "a-ready", environmentId, status: "ready", providerImageId: "im" });
      await seedImageRow({ id: "a-building", environmentId, status: "building" });
      await seedImageRow({ id: "a-failed", environmentId, status: "failed" });

      const superseded = await store.supersedeActiveImages(environmentScope(environmentId));

      expect(superseded).toBe(2);
      expect((await getRow("a-ready"))?.status).toBe("superseded");
      expect((await getRow("a-building"))?.status).toBe("superseded");
      expect((await getRow("a-failed"))?.status).toBe("failed");
    });

    it("hasReadyImageForFingerprint matches only ready rows with the exact fingerprint", async () => {
      const environmentId = await seedEnvironment();
      const store = new ImageBuildStore(env.DB);
      await seedImageRow({
        id: "fp-row",
        environmentId,
        status: "ready",
        providerImageId: "im",
        repositoriesFingerprint: "fp-x",
      });

      const scope = environmentScope(environmentId);
      expect(await store.hasReadyImageForFingerprint(scope, "modal", "fp-x")).toBe(true);
      expect(await store.hasReadyImageForFingerprint(scope, "modal", "fp-y")).toBe(false);
    });
  });

  describe("spawn-time selection", () => {
    it("serves the latest ready image for the scope and provider only", async () => {
      const environmentId = await seedEnvironment({ prebuildEnabled: true });
      const otherId = await seedEnvironment({ prebuildEnabled: true });
      const now = Date.now();

      await seedImageRow({
        id: "sp-older",
        environmentId,
        status: "ready",
        providerImageId: "im-older",
        createdAt: now - 2000,
      });
      await seedImageRow({
        id: "sp-latest",
        environmentId,
        status: "ready",
        providerImageId: "im-latest",
        createdAt: now - 1000,
      });
      await seedImageRow({ id: "sp-building", environmentId, status: "building", createdAt: now });
      await seedImageRow({ id: "sp-failed", environmentId, status: "failed", createdAt: now });
      await seedImageRow({
        id: "sp-superseded",
        environmentId,
        status: "superseded",
        providerImageId: "im-superseded",
        createdAt: now,
      });
      await seedImageRow({
        id: "sp-vercel",
        environmentId,
        status: "ready",
        provider: "vercel",
        providerImageId: "im-vercel",
        createdAt: now,
      });
      await seedImageRow({
        id: "sp-other-env",
        environmentId: otherId,
        status: "ready",
        providerImageId: "im-other",
        createdAt: now,
      });

      const selected = await selectForSpawn(environmentId, "modal");

      expect(selected?.id).toBe("sp-latest");
      expect(selected?.provider_image_id).toBe("im-latest");
      expect((await selectForSpawn(environmentId, "vercel"))?.id).toBe("sp-vercel");
    });

    it("never serves a deleted environment's lingering row", async () => {
      const environmentId = await seedEnvironment({ prebuildEnabled: true });
      await seedImageRow({
        id: "sp-lingering",
        environmentId,
        status: "ready",
        providerImageId: "im-lingering",
      });

      expect((await selectForSpawn(environmentId, "modal"))?.id).toBe("sp-lingering");

      // Raw delete bypasses EnvironmentStore.delete's supersede batch — the
      // lingering ready row must still never be served (the scope resolver's
      // enablement answer is false for a missing environment).
      await env.DB.prepare("DELETE FROM environments WHERE id = ?").bind(environmentId).run();

      expect(await selectForSpawn(environmentId, "modal")).toBeNull();
      expect((await getRow("sp-lingering"))?.status).toBe("ready");
    });

    it("does not serve images of prebuild-disabled environments", async () => {
      const environmentId = await seedEnvironment({ prebuildEnabled: false });
      await seedImageRow({
        id: "sp-disabled",
        environmentId,
        status: "ready",
        providerImageId: "im-disabled",
      });

      expect(await selectForSpawn(environmentId, "modal")).toBeNull();
    });

    it("markRestoreFailed fails only a ready row, exactly once", async () => {
      const environmentId = await seedEnvironment({ prebuildEnabled: true });
      const store = new ImageBuildStore(env.DB);
      await seedImageRow({
        id: "sp-restore",
        environmentId,
        status: "ready",
        providerImageId: "im-restore",
      });
      await seedImageRow({ id: "sp-inflight", environmentId, status: "building" });

      expect(
        await store.markRestoreFailed("sp-restore", "restore failed at spawn: image expired")
      ).toBe(true);
      const failed = await getRow("sp-restore");
      expect(failed?.status).toBe("failed");
      expect(failed?.error_message).toBe("restore failed at spawn: image expired");

      // No longer ready — a repeat (or stale) mark is a no-op.
      expect(await store.markRestoreFailed("sp-restore", "again")).toBe(false);
      expect((await getRow("sp-restore"))?.error_message).toBe(
        "restore failed at spawn: image expired"
      );

      // Building rows belong to the build workflow's failure paths.
      expect(await store.markRestoreFailed("sp-inflight", "nope")).toBe(false);
      expect((await getRow("sp-inflight"))?.status).toBe("building");
    });
  });

  describe("cron-facing routes", () => {
    it("GET /image-builds/enabled returns prebuild-enabled units with fingerprints", async () => {
      const enabledId = await seedEnvironment({
        prebuildEnabled: true,
        repositories: [
          ["acme", "web", 1, "main"],
          ["acme", "api", 2, "develop"],
        ],
      });
      await seedEnvironment({ prebuildEnabled: false });

      const response = await SELF.fetch(`${BASE}/image-builds/enabled`, {
        headers: await authHeaders(),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        units: Array<{
          scopeKind: string;
          scopeId: string;
          repositoriesFingerprint: string;
          repositories: Array<{ repoOwner: string; repoName: string; baseBranch: string }>;
        }>;
        minRuntimeVersion: number;
      };
      expect(body.minRuntimeVersion).toBe(MIN_COMPATIBLE_RUNTIME_VERSION);
      expect(body.units).toHaveLength(1);
      expect(body.units[0].scopeKind).toBe("environment");
      expect(body.units[0].scopeId).toBe(enabledId);
      expect(body.units[0].repositories).toEqual([
        { repoOwner: "acme", repoName: "web", baseBranch: "main" },
        { repoOwner: "acme", repoName: "api", baseBranch: "develop" },
      ]);
      expect(body.units[0].repositoriesFingerprint).toBe(
        await computeRepositoriesFingerprint(body.units[0].repositories)
      );
    });

    it("GET /image-builds/status serves the cross-scope view and the per-scope debug view", async () => {
      const environmentId = await seedEnvironment({ prebuildEnabled: true });
      const otherId = await seedEnvironment({ prebuildEnabled: true });
      const disabledId = await seedEnvironment();
      await seedImageRow({ id: "st-ready", environmentId, status: "ready", providerImageId: "im" });
      await seedImageRow({ id: "st-superseded", environmentId, status: "superseded" });
      await seedImageRow({
        id: "st-failed",
        environmentId,
        status: "failed",
        createdAt: Date.now() - 1000,
      });
      await seedImageRow({ id: "st-other", environmentId: otherId, status: "building" });
      await seedImageRow({
        id: "st-disabled",
        environmentId: disabledId,
        status: "ready",
        providerImageId: "im-d",
      });

      // Cross-scope view: every non-superseded row of prebuild-enabled
      // scopes — failed builds are visible in the aggregate feed (they were
      // silently filtered before the unification); disabled scopes never
      // crowd it.
      const all = await SELF.fetch(`${BASE}/image-builds/status`, {
        headers: await authHeaders(),
      });
      const allBody = (await all.json()) as {
        images: Array<{ id: string; scope_kind: string; scope_id: string }>;
      };
      expect(allBody.images.map((i) => i.id).sort()).toEqual(["st-failed", "st-other", "st-ready"]);
      expect(allBody.images.every((i) => i.scope_kind === "environment")).toBe(true);

      // Per-scope debug view keeps failed rows, drops only superseded.
      const filtered = await SELF.fetch(
        `${BASE}/image-builds/status?scope_kind=environment&scope_id=${environmentId}`,
        { headers: await authHeaders() }
      );
      const filteredBody = (await filtered.json()) as { images: Array<{ id: string }> };
      expect(filteredBody.images.map((i) => i.id)).toEqual(["st-ready", "st-failed"]);
    });

    it("GET /image-builds/status rejects a scope_kind/scope_id half-pair", async () => {
      for (const query of [
        "?scope_kind=environment",
        "?scope_id=env_x",
        "?scope_kind=bogus&scope_id=x",
      ]) {
        const response = await SELF.fetch(`${BASE}/image-builds/status${query}`, {
          headers: await authHeaders(),
        });
        expect(response.status, query).toBe(400);
      }
    });

    it("POST /image-builds/mark-stale fails old building rows", async () => {
      const environmentId = await seedEnvironment();
      await seedImageRow({
        id: "stale-build",
        environmentId,
        status: "building",
        createdAt: Date.now() - 10_000_000,
      });
      await seedImageRow({ id: "fresh-build", environmentId, status: "building" });

      const response = await SELF.fetch(`${BASE}/image-builds/mark-stale`, {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({ max_age_seconds: 3600 }),
      });

      expect(response.status).toBe(200);
      expect(((await response.json()) as { markedFailed: number }).markedFailed).toBe(1);
      expect((await getRow("stale-build"))?.status).toBe("failed");
      expect((await getRow("fresh-build"))?.status).toBe("building");
    });

    it("POST /image-builds/cleanup deletes old failed rows and reaps artifact-less superseded rows", async () => {
      const environmentId = await seedEnvironment();
      await seedImageRow({
        id: "old-failed",
        environmentId,
        status: "failed",
        createdAt: Date.now() - 100_000_000,
      });
      // Superseded before any artifact was recorded (entity delete or secret
      // change mid-build) — reaped directly.
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

      const response = await SELF.fetch(`${BASE}/image-builds/cleanup`, {
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

    it("rejects non-numeric max_age_seconds instead of treating it as 0", async () => {
      const environmentId = await seedEnvironment();
      await seedImageRow({ id: "guard-building", environmentId, status: "building" });
      await seedImageRow({ id: "guard-failed", environmentId, status: "failed" });

      for (const path of ["mark-stale", "cleanup"]) {
        const response = await SELF.fetch(`${BASE}/image-builds/${path}`, {
          method: "POST",
          headers: await authHeaders(),
          body: JSON.stringify({ max_age_seconds: null }),
        });
        // A null that fell through to 0 would fail every building row or
        // delete every failed row.
        expect(response.status, path).toBe(400);
      }
      expect((await getRow("guard-building"))?.status).toBe("building");
      expect((await getRow("guard-failed"))?.status).toBe("failed");
    });

    it("requires internal auth on cron-facing routes", async () => {
      for (const [method, path] of [
        ["GET", "/image-builds/enabled"],
        ["GET", "/image-builds/status"],
        ["POST", "/image-builds/mark-stale"],
        ["POST", "/image-builds/cleanup"],
        ["POST", "/image-builds/trigger/environment/env_x"],
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

  describe("legacy /environment-images aliases (removed with the Modal cutover)", () => {
    it("GET /environment-images/enabled preserves the old environments shape", async () => {
      const enabledId = await seedEnvironment({
        prebuildEnabled: true,
        name: "Legacy Shape",
        repositories: [["acme", "web", 1, "main"]],
      });
      await seedEnvironment({ prebuildEnabled: false });

      const response = await SELF.fetch(`${BASE}/environment-images/enabled`, {
        headers: await authHeaders(),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        environments: Array<{
          id: string;
          name: string;
          repositoriesFingerprint: string;
          repositories: Array<{ repoOwner: string; repoName: string; baseBranch: string }>;
        }>;
        minRuntimeVersion: number;
      };
      expect(body.minRuntimeVersion).toBe(MIN_COMPATIBLE_RUNTIME_VERSION);
      expect(body.environments).toHaveLength(1);
      expect(body.environments[0].id).toBe(enabledId);
      expect(body.environments[0].name).toBe("Legacy Shape");
      expect(body.environments[0].repositories).toEqual([
        { repoOwner: "acme", repoName: "web", baseBranch: "main" },
      ]);
      expect(body.environments[0].repositoriesFingerprint).toBe(
        await computeRepositoriesFingerprint(body.environments[0].repositories)
      );
    });

    it("GET /environment-images/status serves rows keyed by environment_id", async () => {
      const environmentId = await seedEnvironment({ prebuildEnabled: true });
      await seedImageRow({ id: "al-ready", environmentId, status: "ready", providerImageId: "im" });
      await seedImageRow({ id: "al-failed", environmentId, status: "failed" });

      const all = await SELF.fetch(`${BASE}/environment-images/status`, {
        headers: await authHeaders(),
      });
      const allBody = (await all.json()) as {
        images: Array<{ id: string; environment_id: string }>;
      };
      expect(allBody.images.map((i) => i.id).sort()).toEqual(["al-failed", "al-ready"]);
      expect(allBody.images.every((i) => i.environment_id === environmentId)).toBe(true);

      const filtered = await SELF.fetch(
        `${BASE}/environment-images/status?environment_id=${environmentId}`,
        { headers: await authHeaders() }
      );
      const filteredBody = (await filtered.json()) as {
        images: Array<{ id: string; environment_id: string }>;
      };
      expect(filteredBody.images.map((i) => i.id).sort()).toEqual(["al-failed", "al-ready"]);
      expect(filteredBody.images[0].environment_id).toBe(environmentId);
    });

    it("POST /environment-images/mark-stale reaches the unified handler", async () => {
      const environmentId = await seedEnvironment();
      await seedImageRow({
        id: "al-stale",
        environmentId,
        status: "building",
        createdAt: Date.now() - 10_000_000,
      });

      const response = await SELF.fetch(`${BASE}/environment-images/mark-stale`, {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({ max_age_seconds: 3600 }),
      });

      expect(response.status).toBe(200);
      expect(((await response.json()) as { markedFailed: number }).markedFailed).toBe(1);
      expect((await getRow("al-stale"))?.status).toBe("failed");
    });

    it("POST /environment-images/build-complete reaches the unified callback handler", async () => {
      const environmentId = await seedEnvironment();
      await new ImageBuildStore(env.DB).registerBuild({
        id: "al-cb",
        scope: environmentScope(environmentId),
        provider: "modal",
        repositoriesFingerprint: "fp-al",
      });

      const response = await SELF.fetch(`${BASE}/environment-images/build-complete`, {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({
          build_id: "al-cb",
          provider_image_id: "im-al",
          repository_shas: REPOSITORY_SHAS,
          runtime_version: RUNTIME_VERSION,
          build_duration_seconds: 5,
        }),
      });

      expect(response.status).toBe(200);
      expect((await getRow("al-cb"))?.status).toBe("ready");
    });
  });

  describe("cross-scope status regression (aggregate feed includes failed)", () => {
    it("surfaces a scope whose only build failed instead of silently dropping it", async () => {
      const environmentId = await seedEnvironment({ prebuildEnabled: true });
      await seedImageRow({ id: "only-failed", environmentId, status: "failed" });

      const response = await SELF.fetch(`${BASE}/image-builds/status`, {
        headers: await authHeaders(),
      });
      const body = (await response.json()) as {
        images: Array<{ id: string; status: string; scope_id: string }>;
      };

      expect(body.images).toHaveLength(1);
      expect(body.images[0]).toMatchObject({
        id: "only-failed",
        status: "failed",
        scope_id: environmentId,
      });
    });
  });

  describe("build callbacks", () => {
    async function registerBuild(environmentId: string, buildId: string): Promise<void> {
      await new ImageBuildStore(env.DB).registerBuild({
        id: buildId,
        scope: environmentScope(environmentId),
        provider: "modal",
        repositoriesFingerprint: "fp-cb",
      });
    }

    it("POST /image-builds/build-complete registers the image", async () => {
      const environmentId = await seedEnvironment();
      await registerBuild(environmentId, "cb-build");

      const response = await SELF.fetch(`${BASE}/image-builds/build-complete`, {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({
          build_id: "cb-build",
          provider_image_id: "im-cb",
          repository_shas: REPOSITORY_SHAS,
          runtime_version: RUNTIME_VERSION,
          build_duration_seconds: 42.5,
        }),
      });

      expect(response.status).toBe(200);
      const row = await getRow("cb-build");
      expect(row?.status).toBe("ready");
      expect(row?.provider_image_id).toBe("im-cb");
      expect(row?.runtime_version).toBe(RUNTIME_VERSION);
      expect(JSON.parse(row?.repository_shas as string)).toEqual(REPOSITORY_SHAS);
    });

    it("rejects callbacks without internal auth", async () => {
      const environmentId = await seedEnvironment();
      await registerBuild(environmentId, "cb-noauth");

      const response = await SELF.fetch(`${BASE}/image-builds/build-complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          build_id: "cb-noauth",
          provider_image_id: "im",
          repository_shas: REPOSITORY_SHAS,
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
      ["missing repository_shas", { repository_shas: undefined }],
      [
        "repository_shas entry without baseSha",
        { repository_shas: [{ repoOwner: "a", repoName: "b" }] },
      ],
    ])("fails registration closed on %s", async (_label, overrides) => {
      const environmentId = await seedEnvironment();
      await registerBuild(environmentId, "cb-invalid");

      const response = await SELF.fetch(`${BASE}/image-builds/build-complete`, {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({
          build_id: "cb-invalid",
          provider_image_id: "im",
          repository_shas: REPOSITORY_SHAS,
          runtime_version: RUNTIME_VERSION,
          build_duration_seconds: 1,
          ...overrides,
        }),
      });

      expect(response.status).toBe(400);
      expect((await getRow("cb-invalid"))?.status).toBe("building");
    });

    it("POST /image-builds/build-failed marks the build failed", async () => {
      const environmentId = await seedEnvironment();
      await registerBuild(environmentId, "cb-failed");

      const response = await SELF.fetch(`${BASE}/image-builds/build-failed`, {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({ build_id: "cb-failed", error: "setup.failed: boom" }),
      });

      expect(response.status).toBe(200);
      const row = await getRow("cb-failed");
      expect(row?.status).toBe("failed");
      expect(row?.error_message).toBe("setup.failed: boom");
    });

    it("records the artifact when a secret change superseded the build mid-flight", async () => {
      const environmentId = await seedEnvironment();
      await registerBuild(environmentId, "cb-late");
      // Secret-change save-hook flips the in-flight build to superseded.
      await new ImageBuildStore(env.DB).supersedeActiveImages(environmentScope(environmentId));

      const response = await SELF.fetch(`${BASE}/image-builds/build-complete`, {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({
          build_id: "cb-late",
          provider_image_id: "im-late-orphan",
          repository_shas: REPOSITORY_SHAS,
          runtime_version: RUNTIME_VERSION,
          build_duration_seconds: 30,
        }),
      });

      // Rejected — but the already-created provider artifact is recorded on
      // the superseded row so the cleanup reaper reclaims it instead of
      // leaking it (Modal snapshots never expire).
      expect(response.status).toBe(409);
      const row = await getRow("cb-late");
      expect(row?.status).toBe("superseded");
      expect(row?.provider_image_id).toBe("im-late-orphan");
    });

    it("rejects completion for unknown builds with 409", async () => {
      const response = await SELF.fetch(`${BASE}/image-builds/build-complete`, {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({
          build_id: "cb-unknown",
          provider_image_id: "im",
          repository_shas: REPOSITORY_SHAS,
          runtime_version: RUNTIME_VERSION,
          build_duration_seconds: 1,
        }),
      });

      expect(response.status).toBe(409);
    });
  });

  describe("secret-change save-hook", () => {
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
