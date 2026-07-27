/**
 * Image-build lifecycle against real D1: store state machine (register →
 * ready → supersede → reap), the cron-facing routes (enabled/status/
 * mark-stale/cleanup), the build callbacks with single-use token auth and
 * their fail-closed registration, and the secret-change supersede save-hook.
 *
 * Builds are seeded via ImageBuildStore (or raw SQL when a test needs to
 * control created_at) — actually triggering one needs a live Modal
 * deployment, and the SCM-less harness split is the same as PR-4/PR-8.
 */

import { buildServiceAuthHeaders } from "@open-inspect/shared";
import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import { ImageBuildStore } from "../../src/db/image-builds";
import { RepoMetadataStore } from "../../src/db/repo-metadata";
import { computeRepositoriesFingerprint } from "../../src/image-builds/fingerprint";
import { hashImageBuildCallbackToken } from "../../src/image-builds/callback-auth";
import {
  MIN_COMPATIBLE_RUNTIME_VERSION,
  repoImageBuildScope,
  type ImageBuildProvider,
  type ImageBuildScope,
} from "../../src/image-builds/model";
import type { ImageBuildAdapterFactory } from "../../src/image-builds/provider-factory";
import { ImageBuildReaper } from "../../src/image-builds/reaper";
import { resolveScopeEnabled } from "../../src/image-builds/scope";
import type { AnyImageBuildAdapter, DeleteImageInput } from "../../src/image-builds/types";
import { evaluateImageBuildForSpawn } from "../../src/sandbox/lifecycle/image-selection";
import type { Env } from "../../src/types";
import { cleanD1Tables } from "./cleanup";
import {
  RUNTIME_VERSION,
  REPOSITORY_SHAS,
  environmentScope,
  getRow,
  seedEnvironment,
  seedImageRow,
  seedImageRowForScope,
} from "./image-build-helpers";

const BASE = "https://test.local";

/**
 * The exact key set of the `ImageBuildRecordView` wire contract. The status
 * endpoints must serve these and only these — no callback-token or
 * provider-internal columns.
 */
const WIRE_KEYS = [
  "id",
  "scope_kind",
  "scope_id",
  "provider",
  "status",
  "repositories_fingerprint",
  "repository_shas",
  "runtime_version",
  "build_duration_seconds",
  "error_message",
  "created_at",
].sort();

// Modal-provider callback token: 64-hex like the planner mints (the route
// only forwards token-shaped bearers to the workflow).
const MODAL_BUILD_TOKEN = "ab".repeat(32);

/** The cron-facing routes are called by the Modal scheduler under its own sig1 credential. */
async function modalFetch(url: string, init?: { method?: string; body?: string }) {
  const method = init?.method ?? "GET";
  const headers = {
    ...(await buildServiceAuthHeaders({
      service: "modal",
      secret: "test-service-secret-modal",
      method,
      url,
      body: init?.body,
    })),
    ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
  };
  return SELF.fetch(url, { method, headers, body: init?.body });
}

function tokenHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

/**
 * The Vercel/OpenComputer shape: a row whose internal columns all carry real
 * values (Modal rows keep a token hash but never bind a provider session).
 * If a status read leaks columns, this is the row that exposes a live
 * callback-token hash and provider ids.
 */
async function seedRowWithInternalColumns(scope: ImageBuildScope, id: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO image_builds
       (id, scope_kind, scope_id, provider, provider_image_id, provider_session_id,
        callback_token_hash, callback_token_expires_at, callback_token_used_at,
        repositories_fingerprint, repository_shas, runtime_version, status,
        build_duration_seconds, error_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      scope.kind,
      scope.id,
      "vercel",
      "vercel-image-secret",
      "vercel-session-secret",
      "callback-token-hash-secret",
      Date.now() + 60_000,
      null,
      "fp-seeded",
      JSON.stringify(REPOSITORY_SHAS),
      RUNTIME_VERSION,
      "ready",
      12,
      null,
      Date.now()
    )
    .run();
}

/**
 * The spawn-selection path as the Durable Object composes it: the scope
 * resolver answers enablement (and entity existence), then the store serves
 * the plain row read.
 */
async function selectScopeForSpawn(scope: ImageBuildScope, provider: "modal" | "vercel") {
  if (!(await resolveScopeEnabled(env.DB, scope))) return null;
  return new ImageBuildStore(env.DB).getLatestReadyForSpawn(scope, provider);
}

async function selectForSpawn(environmentId: string, provider: "modal" | "vercel") {
  return selectScopeForSpawn(environmentScope(environmentId), provider);
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

    it("consumes the callback token atomically with the ready transition (provider_image path)", async () => {
      const environmentId = await seedEnvironment();
      const store = new ImageBuildStore(env.DB);
      const now = Date.now();
      await store.registerBuild({
        id: "imgb-atomic",
        scope: environmentScope(environmentId),
        provider: "modal",
        repositoriesFingerprint: "fp-atomic",
        callbackTokenHash: "cbhash-atomic",
        callbackTokenExpiresAt: now + 60_000,
      });

      // Wrong token: because the consume and the ready transition are ONE
      // conditional UPDATE, a mismatch commits NEITHER — the build stays
      // 'building' with its single-use token unconsumed and still replayable.
      // This is the fix's core guarantee (a failed transition never burns the
      // token, so the provider's retry can still succeed).
      const rejected = await store.tryMarkImageBuildReady(
        "imgb-atomic",
        "modal",
        "im-atomic",
        REPOSITORY_SHAS,
        RUNTIME_VERSION,
        5_000,
        { tokenHash: "cbhash-wrong", providerSessionId: null, now }
      );
      expect(rejected.type).toBe("not_accepting_completion");
      let row = await getRow("imgb-atomic");
      expect(row?.status).toBe("building");
      expect(row?.callback_token_used_at).toBeNull();
      expect(row?.provider_image_id).toBeNull();

      // Correct token: ready and consume land together.
      const ok = await store.tryMarkImageBuildReady(
        "imgb-atomic",
        "modal",
        "im-atomic",
        REPOSITORY_SHAS,
        RUNTIME_VERSION,
        5_000,
        { tokenHash: "cbhash-atomic", providerSessionId: null, now }
      );
      expect(ok.type).toBe("marked_ready");
      row = await getRow("imgb-atomic");
      expect(row?.status).toBe("ready");
      expect(row?.provider_image_id).toBe("im-atomic");
      expect(row?.callback_token_used_at).toBe(now);

      // The now-consumed token cannot re-fire the terminal transition.
      const replay = await store.tryMarkImageBuildReady(
        "imgb-atomic",
        "modal",
        "im-atomic",
        REPOSITORY_SHAS,
        RUNTIME_VERSION,
        5_000,
        { tokenHash: "cbhash-atomic", providerSessionId: null, now: now + 1 }
      );
      expect(replay.type).toBe("not_accepting_completion");
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

      const response = await modalFetch(`${BASE}/image-builds/enabled`);

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
      const all = await modalFetch(`${BASE}/image-builds/status`);
      const allBody = (await all.json()) as {
        images: Array<{ id: string; scope_kind: string; scope_id: string }>;
      };
      expect(allBody.images.map((i) => i.id).sort()).toEqual(["st-failed", "st-other", "st-ready"]);
      expect(allBody.images.every((i) => i.scope_kind === "environment")).toBe(true);

      // Per-scope debug view keeps failed rows, drops only superseded.
      const filtered = await modalFetch(
        `${BASE}/image-builds/status?scope_kind=environment&scope_id=${environmentId}`
      );
      const filteredBody = (await filtered.json()) as { images: Array<{ id: string }> };
      expect(filteredBody.images.map((i) => i.id)).toEqual(["st-ready", "st-failed"]);
    });

    it("GET /image-builds/status projects only the wire columns (no internal fields)", async () => {
      const environmentId = await seedEnvironment({ prebuildEnabled: true });
      await seedRowWithInternalColumns(environmentScope(environmentId), "leak-check");

      const assertWireKeysOnly = (images: Array<Record<string, unknown>>) => {
        expect(images).toHaveLength(1);
        expect(Object.keys(images[0]).sort()).toEqual(WIRE_KEYS);
        // Redundant with the exact-key-set check, but names the offenders.
        for (const internal of [
          "callback_token_hash",
          "callback_token_expires_at",
          "callback_token_used_at",
          "provider_session_id",
          "provider_image_id",
        ]) {
          expect(images[0]).not.toHaveProperty(internal);
        }
      };

      const cross = await modalFetch(`${BASE}/image-builds/status`);
      assertWireKeysOnly(
        ((await cross.json()) as { images: Array<Record<string, unknown>> }).images
      );

      const perScope = await modalFetch(
        `${BASE}/image-builds/status?scope_kind=environment&scope_id=${environmentId}`
      );
      assertWireKeysOnly(
        ((await perScope.json()) as { images: Array<Record<string, unknown>> }).images
      );
    });

    it("GET /image-builds/status rejects a scope_kind/scope_id half-pair", async () => {
      for (const query of [
        "?scope_kind=environment",
        "?scope_id=env_x",
        "?scope_kind=bogus&scope_id=x",
      ]) {
        const response = await modalFetch(`${BASE}/image-builds/status${query}`);
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

      const response = await modalFetch(`${BASE}/image-builds/mark-stale`, {
        method: "POST",
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
      // Restore-failed row carrying a live artifact and old enough to age out:
      // with the adapter unconfigured the artifact can't be reaped, so the row
      // must NOT be hard-deleted (that was the leak — the snapshot would be
      // orphaned forever). It survives, artifact intact, for a later pass.
      await seedImageRow({
        id: "old-failed-with-artifact",
        environmentId,
        status: "failed",
        providerImageId: "im-restore-orphan",
        createdAt: Date.now() - 100_000_000,
      });

      const response = await modalFetch(`${BASE}/image-builds/cleanup`, {
        method: "POST",
        body: JSON.stringify({ max_age_seconds: 86400 }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        deleted: number;
        reapedFailed: number;
        reapedSuperseded: number;
      };
      expect(body.deleted).toBe(1);
      expect(body.reapedFailed).toBe(0);
      expect(body.reapedSuperseded).toBe(1);
      expect(await getRow("old-failed")).toBeNull();
      expect(await getRow("bare-superseded")).toBeNull();
      expect((await getRow("artifact-superseded"))?.status).toBe("superseded");
      const survivor = await getRow("old-failed-with-artifact");
      expect(survivor?.status).toBe("failed");
      expect(survivor?.provider_image_id).toBe("im-restore-orphan");
    });

    it("deleteOldFailedBuilds ages out only artifact-free failed rows", async () => {
      const environmentId = await seedEnvironment();
      const store = new ImageBuildStore(env.DB);
      await seedImageRow({
        id: "clean-old",
        environmentId,
        status: "failed",
        createdAt: Date.now() - 100_000_000,
      });
      await seedImageRow({
        id: "artifact-old",
        environmentId,
        status: "failed",
        providerImageId: "im-live",
        createdAt: Date.now() - 100_000_000,
      });

      expect(await store.deleteOldFailedBuilds(86_400_000)).toBe(1);
      expect(await getRow("clean-old")).toBeNull();
      // Still points at a live snapshot — the reaper must clear it first.
      expect((await getRow("artifact-old"))?.status).toBe("failed");

      // getFailedImagesWithArtifacts exposes exactly the artifact-bearing row.
      const reapable = await store.getFailedImagesWithArtifacts(25);
      expect(reapable.map((r) => r.id)).toEqual(["artifact-old"]);

      // A stale artifact id (not the one on the row) clears nothing, so a
      // newer artifact could never be nulled without being reaped first.
      expect(await store.clearFailedImageArtifact("artifact-old", "im-stale")).toBe(false);
      expect((await getRow("artifact-old"))?.provider_image_id).toBe("im-live");

      // clearFailedImageArtifact nulls the columns, keeps status/error_message,
      // and is idempotent (a cleared row is no longer selected).
      expect(await store.clearFailedImageArtifact("artifact-old", "im-live")).toBe(true);
      const cleared = await getRow("artifact-old");
      expect(cleared?.status).toBe("failed");
      expect(cleared?.provider_image_id).toBeNull();
      expect(await store.getFailedImagesWithArtifacts(25)).toEqual([]);

      // Now artifact-free and old — the age sweep removes it.
      expect(await store.deleteOldFailedBuilds(86_400_000)).toBe(1);
      expect(await getRow("artifact-old")).toBeNull();
    });

    it("rejects non-numeric max_age_seconds instead of treating it as 0", async () => {
      const environmentId = await seedEnvironment();
      await seedImageRow({ id: "guard-building", environmentId, status: "building" });
      await seedImageRow({ id: "guard-failed", environmentId, status: "failed" });

      for (const path of ["mark-stale", "cleanup"]) {
        const response = await modalFetch(`${BASE}/image-builds/${path}`, {
          method: "POST",
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
        ["GET", "/image-builds/enabled-repos"],
        ["GET", "/image-builds/status"],
        ["POST", "/image-builds/mark-stale"],
        ["POST", "/image-builds/cleanup"],
        ["POST", "/image-builds/trigger/environment/env_x"],
        ["POST", "/image-builds/trigger/repo/acme/web"],
        ["PUT", "/image-builds/toggle/repo/acme/web"],
      ] as const) {
        const response = await SELF.fetch(`${BASE}${path}`, { method });
        expect(response.status, `${method} ${path}`).toBe(401);
      }
    });
  });

  describe("cross-scope status regression (aggregate feed includes failed)", () => {
    it("surfaces a scope whose only build failed instead of silently dropping it", async () => {
      const environmentId = await seedEnvironment({ prebuildEnabled: true });
      await seedImageRow({ id: "only-failed", environmentId, status: "failed" });

      const response = await modalFetch(`${BASE}/image-builds/status`);
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

  describe("cleanup reaper end-to-end over real D1", () => {
    /**
     * Stub factory standing in for the unconfigured provider adapter: records
     * every deleted artifact and throws for a nominated "stuck" id so the
     * best-effort retry path is exercised against real rows.
     */
    function stubFactory(opts?: { stuckImageId?: string }): {
      factory: ImageBuildAdapterFactory;
      deleted: string[];
    } {
      const deleted: string[] = [];
      const adapter = {
        async deleteImage({ image }: DeleteImageInput) {
          if (image.providerImageId === opts?.stuckImageId) throw new Error("provider 500");
          deleted.push(image.providerImageId);
        },
      } as unknown as AnyImageBuildAdapter;
      const factory: ImageBuildAdapterFactory = {
        create: (_provider: ImageBuildProvider) => adapter,
      } as ImageBuildAdapterFactory;
      return { factory, deleted };
    }

    const ctx = { request_id: "req-reap", trace_id: "trace-reap" };

    it("reaps failed and superseded artifacts, retains failed rows, deletes aged-out rows", async () => {
      const environmentId = await seedEnvironment();
      const old = Date.now() - 100_000_000;

      await seedImageRow({
        id: "e2e-superseded",
        environmentId,
        status: "superseded",
        providerImageId: "im-superseded",
      });
      await seedImageRow({ id: "e2e-superseded-bare", environmentId, status: "superseded" });
      // Restore-failed row (fresh) carrying a live artifact.
      await seedImageRow({
        id: "e2e-failed-artifact",
        environmentId,
        status: "failed",
        providerImageId: "im-restore",
      });
      await env.DB.prepare(`UPDATE image_builds SET error_message = ? WHERE id = ?`)
        .bind("restore failed at spawn: image expired", "e2e-failed-artifact")
        .run();
      // Failed row whose artifact delete fails — artifact must not be lost.
      await seedImageRow({
        id: "e2e-failed-stuck",
        environmentId,
        status: "failed",
        providerImageId: "im-stuck",
      });
      // Artifact-free failed rows: old ages out, fresh survives.
      await seedImageRow({ id: "e2e-failed-old", environmentId, status: "failed", createdAt: old });
      await seedImageRow({ id: "e2e-failed-fresh", environmentId, status: "failed" });

      const { factory, deleted } = stubFactory({ stuckImageId: "im-stuck" });
      const reaper = new ImageBuildReaper(new ImageBuildStore(env.DB), factory);

      const result = await reaper.cleanupImages(86_400_000, ctx);

      expect(result).toEqual({ deletedFailed: 1, reapedFailed: 1, reapedSuperseded: 2 });
      expect(deleted.sort()).toEqual(["im-restore", "im-superseded"]);

      // Superseded rows: artifact deleted then row removed.
      expect(await getRow("e2e-superseded")).toBeNull();
      expect(await getRow("e2e-superseded-bare")).toBeNull();

      // Failed-with-artifact: artifact reclaimed, row kept as failed with its
      // error_message, artifact columns nulled.
      const reaped = await getRow("e2e-failed-artifact");
      expect(reaped?.status).toBe("failed");
      expect(reaped?.provider_image_id).toBeNull();
      expect(reaped?.error_message).toBe("restore failed at spawn: image expired");

      // Stuck failed row: artifact NOT lost — still on the row for the next tick.
      const stuck = await getRow("e2e-failed-stuck");
      expect(stuck?.status).toBe("failed");
      expect(stuck?.provider_image_id).toBe("im-stuck");

      // Artifact-free failed rows age out by cutoff only.
      expect(await getRow("e2e-failed-old")).toBeNull();
      expect((await getRow("e2e-failed-fresh"))?.status).toBe("failed");
    });

    it("is idempotent: a second pass reaps nothing new", async () => {
      const environmentId = await seedEnvironment();
      await seedImageRow({
        id: "idem-failed-artifact",
        environmentId,
        status: "failed",
        providerImageId: "im-idem",
      });

      const first = stubFactory();
      const reaper = new ImageBuildReaper(new ImageBuildStore(env.DB), first.factory);
      await reaper.cleanupImages(86_400_000, ctx);
      expect(first.deleted).toEqual(["im-idem"]);

      const second = stubFactory();
      const reaper2 = new ImageBuildReaper(new ImageBuildStore(env.DB), second.factory);
      const result = await reaper2.cleanupImages(86_400_000, ctx);

      expect(second.deleted).toEqual([]);
      expect(result.reapedFailed).toBe(0);
      expect((await getRow("idem-failed-artifact"))?.provider_image_id).toBeNull();
    });
  });

  describe("build callbacks", () => {
    async function registerBuild(environmentId: string, buildId: string): Promise<void> {
      await new ImageBuildStore(env.DB).registerBuild({
        id: buildId,
        scope: environmentScope(environmentId),
        provider: "modal",
        repositoriesFingerprint: "fp-cb",
        callbackTokenHash: await hashImageBuildCallbackToken(MODAL_BUILD_TOKEN, env as Env),
        callbackTokenExpiresAt: Date.now() + 60_000,
      });
    }

    it("POST /image-builds/build-complete registers the image", async () => {
      const environmentId = await seedEnvironment();
      await registerBuild(environmentId, "cb-build");

      const response = await SELF.fetch(`${BASE}/image-builds/build-complete`, {
        method: "POST",
        headers: tokenHeaders(MODAL_BUILD_TOKEN),
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

    it("rejects callbacks without a callback token", async () => {
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
        headers: tokenHeaders(MODAL_BUILD_TOKEN),
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
        headers: tokenHeaders(MODAL_BUILD_TOKEN),
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
        headers: tokenHeaders(MODAL_BUILD_TOKEN),
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
        headers: tokenHeaders(MODAL_BUILD_TOKEN),
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

  describe("callback-token auth on the unified store (provider_session builds)", () => {
    // Folded from the deleted repo-images store suite: the single-use,
    // session-bound, expiring token semantics survive unchanged on the
    // unified table.
    const TOKEN_SCOPE = repoImageBuildScope("acme", "web");

    async function seedTokenBuild(
      id: string,
      opts?: { expiresAt?: number }
    ): Promise<ImageBuildStore> {
      const store = new ImageBuildStore(env.DB);
      await store.registerBuild({
        id,
        scope: TOKEN_SCOPE,
        provider: "vercel",
        repositoriesFingerprint: "fp-token",
        callbackTokenHash: "hash-1",
        callbackTokenExpiresAt: opts?.expiresAt ?? Date.now() + 60_000,
      });
      await store.bindProviderSession(id, "vercel", "vercel-session-1");
      return store;
    }

    it("consumes a valid token exactly once and rejects replays", async () => {
      const store = await seedTokenBuild("tok-once");
      const params = {
        buildId: "tok-once",
        provider: "vercel" as const,
        tokenHash: "hash-1",
        providerSessionId: "vercel-session-1",
        now: Date.now(),
      };

      const consumed = await store.consumeCallbackToken(params);
      expect(consumed).toMatchObject({ id: "tok-once", scope: TOKEN_SCOPE, provider: "vercel" });

      expect(await store.consumeCallbackToken(params)).toBeNull();
    });

    it("verifies a callback token without consuming it", async () => {
      const store = await seedTokenBuild("tok-verify");

      expect(
        await store.verifyCallbackToken({
          buildId: "tok-verify",
          provider: "vercel",
          tokenHash: "hash-1",
          providerSessionId: "vercel-session-1",
          now: Date.now(),
        })
      ).toBe(true);
      expect((await getRow("tok-verify"))?.callback_token_used_at).toBeNull();
    });

    it("allows failure reporting after an authenticated malformed completion", async () => {
      const token = "a".repeat(64);
      const store = new ImageBuildStore(env.DB);
      await store.registerBuild({
        id: "tok-malformed",
        scope: TOKEN_SCOPE,
        provider: "vercel",
        repositoriesFingerprint: "fp-token",
        callbackTokenHash: await hashImageBuildCallbackToken(token, env as Env),
        callbackTokenExpiresAt: Date.now() + 60_000,
      });
      await store.bindProviderSession("tok-malformed", "vercel", "vercel-session-1");

      const completion = await SELF.fetch(`${BASE}/image-builds/build-complete`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          build_id: "tok-malformed",
          provider_session_id: "vercel-session-1",
          repository_shas: REPOSITORY_SHAS,
          build_duration_seconds: 1,
        }),
      });

      expect(completion.status).toBe(400);
      expect((await getRow("tok-malformed"))?.callback_token_used_at).toBeNull();

      const failure = await SELF.fetch(`${BASE}/image-builds/build-failed`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          build_id: "tok-malformed",
          provider_session_id: "vercel-session-1",
          error: "repo image build-complete callback failed",
        }),
      });

      expect(failure.status).toBe(200);
      const row = await getRow("tok-malformed");
      expect(row?.status).toBe("failed");
      expect(row?.callback_token_used_at).not.toBeNull();
    });

    it("rejects a mismatched provider session without consuming the token", async () => {
      const store = await seedTokenBuild("tok-session");

      const consumed = await store.consumeCallbackToken({
        buildId: "tok-session",
        provider: "vercel",
        tokenHash: "hash-1",
        providerSessionId: "vercel-session-other",
        now: Date.now(),
      });

      expect(consumed).toBeNull();
      expect((await getRow("tok-session"))?.callback_token_used_at).toBeNull();
    });

    it("rejects an expired token without marking it used", async () => {
      const store = await seedTokenBuild("tok-expired", { expiresAt: Date.now() - 1000 });

      const consumed = await store.consumeCallbackToken({
        buildId: "tok-expired",
        provider: "vercel",
        tokenHash: "hash-1",
        providerSessionId: "vercel-session-1",
        now: Date.now(),
      });

      expect(consumed).toBeNull();
      expect((await getRow("tok-expired"))?.callback_token_used_at).toBeNull();
    });

    it("marks the build failed and consumes the token in one transition", async () => {
      const store = await seedTokenBuild("tok-fail");

      const failed = await store.markBuildFailedWithCallbackToken({
        buildId: "tok-fail",
        provider: "vercel",
        tokenHash: "hash-1",
        providerSessionId: "vercel-session-1",
        error: "setup.failed: boom",
        now: Date.now(),
      });

      expect(failed).toBe(true);
      const row = await getRow("tok-fail");
      expect(row?.status).toBe("failed");
      expect(row?.error_message).toBe("setup.failed: boom");
      expect(row?.callback_token_used_at).not.toBeNull();

      // The consumed token authorizes nothing further.
      expect(
        await store.consumeCallbackToken({
          buildId: "tok-fail",
          provider: "vercel",
          tokenHash: "hash-1",
          providerSessionId: "vercel-session-1",
          now: Date.now(),
        })
      ).toBeNull();
    });
  });

  describe("repo scope", () => {
    const REPO_SCOPE = repoImageBuildScope("acme", "web");

    async function enableRepo(owner = "acme", name = "web"): Promise<void> {
      await new RepoMetadataStore(env.DB).setImageBuildEnabled(owner, name, true);
    }

    it("spawn selection serves an enabled repo's latest ready image on the provider", async () => {
      await enableRepo();
      const now = Date.now();
      await seedImageRowForScope(REPO_SCOPE, {
        id: "rp-older",
        status: "ready",
        providerImageId: "im-older",
        createdAt: now - 2000,
      });
      await seedImageRowForScope(REPO_SCOPE, {
        id: "rp-latest",
        status: "ready",
        providerImageId: "im-latest",
        createdAt: now - 1000,
      });
      await seedImageRowForScope(REPO_SCOPE, {
        id: "rp-vercel",
        status: "ready",
        provider: "vercel",
        providerImageId: "im-vercel",
        createdAt: now,
      });

      expect((await selectScopeForSpawn(REPO_SCOPE, "modal"))?.id).toBe("rp-latest");
      expect((await selectScopeForSpawn(REPO_SCOPE, "vercel"))?.id).toBe("rp-vercel");
    });

    it("never serves a disabled or unknown repo's lingering rows", async () => {
      await seedImageRowForScope(REPO_SCOPE, {
        id: "rp-unknown",
        status: "ready",
        providerImageId: "im-unknown",
      });

      // No repo_metadata row at all: never served.
      expect(await selectScopeForSpawn(REPO_SCOPE, "modal")).toBeNull();

      await enableRepo();
      expect((await selectScopeForSpawn(REPO_SCOPE, "modal"))?.id).toBe("rp-unknown");

      // Toggled off: the frozen image would drift unboundedly, so it stops
      // being served (spawns fall back to base; the row itself survives).
      await new RepoMetadataStore(env.DB).setImageBuildEnabled("acme", "web", false);
      expect(await selectScopeForSpawn(REPO_SCOPE, "modal")).toBeNull();
    });

    it("matches sessions by the one-element fingerprint; non-default-branch sessions miss", async () => {
      // Repo images are built on the default branch; the fingerprint match
      // reproduces the old base_branch spawn filter for a one-repo set.
      await enableRepo();
      const defaultBranchSet = [{ repoOwner: "acme", repoName: "web", baseBranch: "main" }];
      await seedImageRowForScope(REPO_SCOPE, {
        id: "rp-fp",
        status: "ready",
        providerImageId: "im-fp",
        repositoriesFingerprint: await computeRepositoriesFingerprint(defaultBranchSet),
      });

      const row = await selectScopeForSpawn(REPO_SCOPE, "modal");
      expect(row?.id).toBe("rp-fp");

      const onDefault = await evaluateImageBuildForSpawn(row, defaultBranchSet);
      expect(onDefault.outcome).toBe("selected");

      const onFeature = await evaluateImageBuildForSpawn(row, [
        { repoOwner: "acme", repoName: "web", baseBranch: "feature/x" },
      ]);
      expect(onFeature).toEqual({
        outcome: "miss",
        reason: "fingerprint_mismatch",
        imageBuildId: "rp-fp",
      });
    });

    it("rejects a ready repo image below the runtime floor at selection", async () => {
      // Deliberate behavior change: the old repo path had no floor, so a
      // stale image (v52 restoring into a v53 world) kept being selected.
      await enableRepo();
      const repositories = [{ repoOwner: "acme", repoName: "web", baseBranch: "main" }];
      await seedImageRowForScope(REPO_SCOPE, {
        id: "rp-stale",
        status: "ready",
        providerImageId: "im-stale",
        runtimeVersion: "v52-legacy-runtime",
        repositoriesFingerprint: await computeRepositoriesFingerprint(repositories),
      });

      const row = await selectScopeForSpawn(REPO_SCOPE, "modal");
      const result = await evaluateImageBuildForSpawn(row, repositories);

      expect(result).toEqual({
        outcome: "miss",
        reason: "runtime_below_floor",
        imageBuildId: "rp-stale",
      });
    });

    it("registerBuild admits exactly one in-flight build per repo scope", async () => {
      // Deliberate behavior change: the old repo subsystem stacked concurrent
      // builds and raced them to mark-ready.
      const store = new ImageBuildStore(env.DB);
      const build = (id: string) => ({
        id,
        scope: REPO_SCOPE,
        provider: "modal" as const,
        repositoriesFingerprint: "fp-race",
      });

      expect(await store.registerBuild(build("rp-race-a"))).toBe(true);
      expect(await store.registerBuild(build("rp-race-b"))).toBe(false);
      expect(await getRow("rp-race-b")).toBeNull();
    });

    it("cross-scope status includes enabled repos' rows alongside environment rows", async () => {
      const environmentId = await seedEnvironment({ prebuildEnabled: true });
      await seedImageRow({
        id: "cs-env",
        environmentId,
        status: "ready",
        providerImageId: "im-env",
      });
      await enableRepo();
      await seedImageRowForScope(REPO_SCOPE, {
        id: "cs-repo-ready",
        status: "ready",
        providerImageId: "im-repo",
      });
      await seedImageRowForScope(REPO_SCOPE, { id: "cs-repo-failed", status: "failed" });
      // Disabled repo rows never crowd the aggregate feed.
      await seedImageRowForScope(repoImageBuildScope("acme", "other"), {
        id: "cs-disabled",
        status: "ready",
        providerImageId: "im-disabled",
      });

      const response = await modalFetch(`${BASE}/image-builds/status`);
      const body = (await response.json()) as {
        images: Array<{ id: string; scope_kind: string; scope_id: string }>;
      };

      expect(body.images.map((i) => i.id).sort()).toEqual([
        "cs-env",
        "cs-repo-failed",
        "cs-repo-ready",
      ]);
      expect(body.images.find((i) => i.id === "cs-repo-ready")).toMatchObject({
        scope_kind: "repo",
        scope_id: "acme/web",
      });
    });

    it("serves the per-scope debug view for a repo scope", async () => {
      await enableRepo();
      await seedImageRowForScope(REPO_SCOPE, {
        id: "ps-ready",
        status: "ready",
        providerImageId: "im",
      });
      await seedImageRowForScope(REPO_SCOPE, { id: "ps-superseded", status: "superseded" });

      const response = await modalFetch(
        `${BASE}/image-builds/status?scope_kind=repo&scope_id=acme/web`
      );
      const body = (await response.json()) as { images: Array<{ id: string }> };

      expect(body.images.map((i) => i.id)).toEqual(["ps-ready"]);
    });

    it("GET /image-builds/enabled skips repo units whose repository cannot be resolved", async () => {
      // The integration harness has no source-control provider configured, so
      // the repo unit's default-branch resolution fails — the feed must skip
      // it with a warning instead of failing, keeping environment units live.
      const environmentId = await seedEnvironment({ prebuildEnabled: true });
      await enableRepo();

      const response = await modalFetch(`${BASE}/image-builds/enabled`);

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        units: Array<{ scopeKind: string; scopeId: string }>;
      };
      expect(body.units).toEqual([
        expect.objectContaining({ scopeKind: "environment", scopeId: environmentId }),
      ]);
    });

    it("GET /image-builds/enabled-repos serves persisted flags without resolution", async () => {
      // Same SCM-less harness in which the units feed skips the repo — the
      // persisted-flags feed still serves it, so the settings UI's toggle
      // state never flickers off on a transient resolution failure.
      await enableRepo();

      const response = await modalFetch(`${BASE}/image-builds/enabled-repos`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        repos: [{ repoOwner: "acme", repoName: "web" }],
      });
    });

    it("PUT /image-builds/toggle/repo/:owner/:name resolves on enable, never on disable", async () => {
      const store = new RepoMetadataStore(env.DB);

      // The integration harness has no source-control provider configured, so
      // enabling — which resolves the repo through the trigger path's
      // canonical resolver first — fails without persisting the flag.
      const enable = await modalFetch(`${BASE}/image-builds/toggle/repo/Acme/Web`, {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
      });
      expect(enable.status).toBe(500);
      expect(await store.getImageBuildEnabled("acme", "web")).toBe(false);

      // Disabling never resolves — a repo that became unresolvable must
      // remain disableable.
      await enableRepo();
      const disable = await modalFetch(`${BASE}/image-builds/toggle/repo/acme/web`, {
        method: "PUT",
        body: JSON.stringify({ enabled: false }),
      });
      expect(disable.status).toBe(200);
      await expect(disable.json()).resolves.toEqual({ ok: true, enabled: false });
      expect(await store.getImageBuildEnabled("acme", "web")).toBe(false);
    });

    it("rejects a non-boolean toggle body", async () => {
      const response = await modalFetch(`${BASE}/image-builds/toggle/repo/acme/web`, {
        method: "PUT",
        body: JSON.stringify({ enabled: "yes" }),
      });

      expect(response.status).toBe(400);
      expect(await new RepoMetadataStore(env.DB).getImageBuildEnabled("acme", "web")).toBe(false);
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

      const response = await modalFetch(`${BASE}/environments/${environmentId}/secrets`, {
        method: "PUT",
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
      await modalFetch(`${BASE}/environments/${environmentId}/secrets`, {
        method: "PUT",
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

      const response = await modalFetch(`${BASE}/environments/${environmentId}/secrets/API_KEY`, {
        method: "DELETE",
      });

      expect(response.status).toBe(200);
      expect((await getRow("del-ready-2"))?.status).toBe("superseded");
    });
  });
});
