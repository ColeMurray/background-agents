import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import {
  DELETE_OLD_FAILED_BUILDS_SQL,
  FAILED_IMAGE_ARTIFACTS_SQL,
  ImageBuildStore,
  MARK_STALE_IMAGE_BUILDS_SQL,
  PROVIDER_SESSION_CLEANUP_SQL,
  RECOVERABLE_IMAGE_FINALIZATIONS_SQL,
  SUPERSEDED_IMAGES_SQL,
} from "../../src/db/image-builds";
import { ImageBuildFinalizer } from "../../src/image-builds/finalizer";
import { cleanD1Tables } from "./cleanup";
import { environmentScope, getRow, seedEnvironment } from "./image-build-helpers";

describe("ImageBuildStore finalization state", () => {
  beforeEach(cleanD1Tables);

  it("records a cleanup obligation when a provider session is bound", async () => {
    const environmentId = await seedEnvironment();
    const store = new ImageBuildStore(env.DB);
    await store.registerBuild({
      id: "build-1",
      scope: environmentScope(environmentId),
      provider: "modal",
      repositoriesFingerprint: "fingerprint-1",
    });

    expect(await store.bindProviderSession("build-1", "modal", "session-1")).toBe(true);

    const row = await getRow("build-1");
    expect(row?.provider_session_id).toBe("session-1");
    expect(row?.provider_session_cleanup_pending).toBe(1);
  });

  it("accepts a successful callback once and replays only the same completion", async () => {
    const environmentId = await seedEnvironment();
    const store = new ImageBuildStore(env.DB);
    const now = Date.now();
    await store.registerBuild({
      id: "build-1",
      scope: environmentScope(environmentId),
      provider: "modal",
      repositoriesFingerprint: "fingerprint-1",
      callbackTokenHash: "token-hash",
      callbackTokenExpiresAt: now + 60_000,
    });
    await store.bindProviderSession("build-1", "modal", "session-1");

    const completion = {
      buildId: "build-1",
      provider: "modal" as const,
      providerSessionId: "session-1",
      tokenHash: "token-hash",
      completionHash: "completion-hash",
      repositoryShas: [{ repoOwner: "acme", repoName: "web", baseSha: "abc123" }],
      runtimeVersion: "v53-runtime",
      buildDurationMs: 12_500,
      now,
    };

    expect(
      await store.finalization.authorizeCompletionCallback({
        buildId: "build-1",
        providerSessionId: "session-1",
        tokenHash: "token-hash",
        now,
      })
    ).toMatchObject({ authorization: "fresh" });
    expect(await store.finalization.acceptSuccessfulCompletion(completion)).toBe("accepted");
    expect(
      await store.finalization.authorizeCompletionCallback({
        buildId: "build-1",
        providerSessionId: "session-1",
        tokenHash: "token-hash",
        now: now + 1,
      })
    ).toMatchObject({ authorization: "accepted" });
    expect(
      await store.finalization.acceptSuccessfulCompletion({ ...completion, now: now + 1 })
    ).toBe("replayed");
    expect(
      await store.finalization.acceptSuccessfulCompletion({
        ...completion,
        completionHash: "conflicting-hash",
        now: now + 1,
      })
    ).toBe("rejected");

    const row = await getRow("build-1");
    expect(row?.status).toBe("building");
    expect(row?.completion_hash).toBe("completion-hash");
    expect(row?.callback_token_used_at).toBe(now);
    expect(row?.runtime_version).toBe("v53-runtime");
    expect(row?.build_duration_seconds).toBe(12.5);
  });

  it("recovers an accepted unleased finalization before artifact persistence", async () => {
    const environmentId = await seedEnvironment();
    const store = new ImageBuildStore(env.DB);
    const now = Date.now();
    await store.registerBuild({
      id: "build-accepted-unleased",
      scope: environmentScope(environmentId),
      provider: "modal",
      repositoriesFingerprint: "fingerprint-1",
      callbackTokenHash: "token-hash",
      callbackTokenExpiresAt: now + 60_000,
    });
    await store.bindProviderSession("build-accepted-unleased", "modal", "session-1");
    await store.finalization.acceptSuccessfulCompletion({
      buildId: "build-accepted-unleased",
      provider: "modal",
      providerSessionId: "session-1",
      tokenHash: "token-hash",
      completionHash: "completion-hash",
      repositoryShas: [],
      runtimeVersion: "v53-runtime",
      buildDurationMs: 1_000,
      now,
    });

    expect((await getRow("build-accepted-unleased"))?.provider_image_id).toBeNull();
    expect(await store.listRecoverableFinalizations(now + 1)).toEqual([
      {
        id: "build-accepted-unleased",
        completion_hash: "completion-hash",
        callback_token_used_at: now,
      },
    ]);
  });

  it("lists every recoverable finalization in one scan", async () => {
    const store = new ImageBuildStore(env.DB);
    for (const [index, callbackTime] of [10, 20, 30].entries()) {
      const environmentId = await seedEnvironment();
      const buildId = `recover-page-${index + 1}`;
      await store.registerBuild({
        id: buildId,
        scope: environmentScope(environmentId),
        provider: "modal",
        repositoriesFingerprint: `fingerprint-${index + 1}`,
        callbackTokenHash: `token-${index + 1}`,
        callbackTokenExpiresAt: 100,
      });
      await store.bindProviderSession(buildId, "modal", `session-${index + 1}`);
      await store.finalization.acceptSuccessfulCompletion({
        buildId,
        provider: "modal",
        providerSessionId: `session-${index + 1}`,
        tokenHash: `token-${index + 1}`,
        completionHash: `completion-${index + 1}`,
        repositoryShas: [],
        runtimeVersion: "v53-runtime",
        buildDurationMs: 1_000,
        now: callbackTime,
      });
    }

    const rows = await store.listRecoverableFinalizations(100);

    expect(rows.map((row) => row.id)).toEqual([
      "recover-page-1",
      "recover-page-2",
      "recover-page-3",
    ]);
  });

  it("durably accepts a failed callback while retaining the cleanup handle", async () => {
    const environmentId = await seedEnvironment();
    const store = new ImageBuildStore(env.DB);
    const now = Date.now();
    await store.registerBuild({
      id: "build-failed",
      scope: environmentScope(environmentId),
      provider: "vercel",
      repositoriesFingerprint: "fingerprint-1",
      callbackTokenHash: "token-hash",
      callbackTokenExpiresAt: now + 60_000,
    });
    await store.bindProviderSession("build-failed", "vercel", "session-failed");

    const failure = {
      buildId: "build-failed",
      provider: "vercel" as const,
      providerSessionId: "session-failed",
      tokenHash: "token-hash",
      completionHash: "failure-hash",
      errorMessage: "setup failed",
      now,
    };

    expect(await store.finalization.acceptFailedCompletion(failure)).toBe("accepted");
    expect(await store.finalization.acceptFailedCompletion({ ...failure, now: now + 1 })).toBe(
      "replayed"
    );

    const row = await getRow("build-failed");
    expect(row?.status).toBe("failed");
    expect(row?.completion_hash).toBe("failure-hash");
    expect(row?.error_message).toBe("setup failed");
    expect(row?.provider_session_id).toBe("session-failed");
    expect(row?.provider_session_cleanup_pending).toBe(1);
  });

  it("delivers a failed callback to provider-session cleanup exactly once", async () => {
    const environmentId = await seedEnvironment();
    const store = new ImageBuildStore(env.DB);
    const now = Date.now();
    const completionHash = "b".repeat(64);
    await store.registerBuild({
      id: "build-failed-cleanup",
      scope: environmentScope(environmentId),
      provider: "modal",
      repositoriesFingerprint: "fingerprint-1",
      callbackTokenHash: "token-hash",
      callbackTokenExpiresAt: now + 60_000,
    });
    await store.bindProviderSession("build-failed-cleanup", "modal", "session-failed-cleanup");
    await store.finalization.acceptFailedCompletion({
      buildId: "build-failed-cleanup",
      provider: "modal",
      providerSessionId: "session-failed-cleanup",
      tokenHash: "token-hash",
      completionHash,
      errorMessage: "setup failed",
      now,
    });

    const adapter = {
      startBuild: vi.fn(),
      deleteImage: vi.fn(),
      finalizeSuccessfulBuild: vi.fn(),
      cleanupCompletedBuild: vi.fn(),
      cleanupFailedBuild: vi.fn(async () => undefined),
    };
    const finalizer = new ImageBuildFinalizer(store, {
      create: vi.fn(() => adapter),
    });
    const job = {
      version: 1 as const,
      buildId: "build-failed-cleanup",
      completionHash,
    };

    await expect(finalizer.process(job, { request_id: "queue-failed-1" })).resolves.toEqual({
      type: "completed",
    });
    await expect(finalizer.process(job, { request_id: "queue-failed-2" })).resolves.toEqual({
      type: "completed",
    });

    expect(await getRow("build-failed-cleanup")).toMatchObject({
      status: "failed",
      provider_session_id: null,
      provider_session_cleanup_pending: 0,
    });
    expect(adapter.finalizeSuccessfulBuild).not.toHaveBeenCalled();
    expect(adapter.cleanupFailedBuild).toHaveBeenCalledTimes(1);
  });

  it("never hard-deletes a terminal row while provider-session cleanup is pending", async () => {
    const environmentId = await seedEnvironment();
    const store = new ImageBuildStore(env.DB);
    await store.registerBuild({
      id: "build-pending-cleanup",
      scope: environmentScope(environmentId),
      provider: "modal",
      repositoriesFingerprint: "fingerprint-1",
    });
    await store.bindProviderSession("build-pending-cleanup", "modal", "session-pending");
    await store.markBuildFailed("build-pending-cleanup", "modal", "failed");
    await env.DB.prepare("UPDATE image_builds SET created_at = 1 WHERE id = ?")
      .bind("build-pending-cleanup")
      .run();

    expect(await store.deleteOldFailedBuilds(1)).toBe(0);
    expect(await getRow("build-pending-cleanup")).not.toBeNull();
  });

  it("deletes a superseded row only after clearing its exact reaped artifact", async () => {
    const environmentId = await seedEnvironment();
    const store = new ImageBuildStore(env.DB);
    await store.registerBuild({
      id: "build-superseded",
      scope: environmentScope(environmentId),
      provider: "modal",
      repositoriesFingerprint: "fingerprint-1",
    });
    await env.DB.prepare(
      `UPDATE image_builds
       SET status = 'superseded', provider_image_id = 'image-1'
       WHERE id = 'build-superseded'`
    ).run();

    expect(await store.deleteSupersededImage("build-superseded")).toBe(false);
    expect(await store.deleteSupersededImage("build-superseded", "image-other")).toBe(false);
    expect(await store.deleteSupersededImage("build-superseded", "image-1")).toBe(true);
    expect(await getRow("build-superseded")).toBeNull();
  });

  it("quarantines an artifact when its build is superseded before persistence", async () => {
    const environmentId = await seedEnvironment();
    const store = new ImageBuildStore(env.DB);
    const now = Date.now();
    await store.registerBuild({
      id: "build-quarantine",
      scope: environmentScope(environmentId),
      provider: "modal",
      repositoriesFingerprint: "fingerprint-1",
      callbackTokenHash: "token-hash",
      callbackTokenExpiresAt: now + 60_000,
    });
    await store.bindProviderSession("build-quarantine", "modal", "session-1");
    await store.finalization.acceptSuccessfulCompletion({
      buildId: "build-quarantine",
      provider: "modal",
      providerSessionId: "session-1",
      tokenHash: "token-hash",
      completionHash: "completion-hash",
      repositoryShas: [{ repoOwner: "acme", repoName: "web", baseSha: "abc123" }],
      runtimeVersion: "v53-runtime",
      buildDurationMs: 12_500,
      now,
    });
    await store.supersedeActiveImages(environmentScope(environmentId));

    expect(
      await store.finalization.quarantineArtifact({
        buildId: "build-quarantine",
        provider: "modal",
        providerSessionId: "session-1",
        completionHash: "completion-hash",
        providerImageId: "image-orphan",
        error: "compensation failed",
      })
    ).toBe(true);
    expect(await getRow("build-quarantine")).toMatchObject({
      status: "superseded",
      provider_image_id: "image-orphan",
      provider_session_cleanup_pending: 1,
    });
  });

  it("lists terminal cleanup obligations, including legacy rows without a cleanup flag", async () => {
    await seedEnvironment({ id: "env_enabled", prebuildEnabled: true });
    const store = new ImageBuildStore(env.DB);

    await store.registerBuild({
      id: "cleanup-terminal",
      scope: environmentScope("env_enabled"),
      provider: "modal",
      repositoriesFingerprint: "fp",
    });
    await store.bindProviderSession("cleanup-terminal", "modal", "session-terminal");
    await store.markBuildFailed("cleanup-terminal", "modal", "failed");
    // Legacy terminal rows predate the cleanup flag. They are swept naturally
    // without a one-off backfill.
    await env.DB.prepare(
      "UPDATE image_builds SET provider_session_cleanup_pending = NULL WHERE id = ?"
    )
      .bind("cleanup-terminal")
      .run();

    expect(await store.listSessionCleanup()).toEqual([
      expect.objectContaining({
        id: "cleanup-terminal",
        provider_session_id: "session-terminal",
      }),
    ]);
  });

  it("uses ordered indexes for full maintenance scans", async () => {
    async function explain(sql: string, bindings: unknown[]): Promise<string> {
      const result = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...bindings)
        .all<{ detail: string }>();
      return (result.results ?? []).map((row) => row.detail).join("\n");
    }

    const plans = {
      cleanup: await explain(PROVIDER_SESSION_CLEANUP_SQL, []),
      superseded: await explain(SUPERSEDED_IMAGES_SQL, []),
      failedArtifact: await explain(FAILED_IMAGE_ARTIFACTS_SQL, []),
      failedHistoryDelete: await explain(DELETE_OLD_FAILED_BUILDS_SQL, [100]),
      staleRecovery: await explain(MARK_STALE_IMAGE_BUILDS_SQL, ["timed out", 100]),
      finalizationRecovery: await explain(RECOVERABLE_IMAGE_FINALIZATIONS_SQL, [200]),
    };

    expect(plans.cleanup).toContain("idx_image_builds_session_cleanup");
    expect(plans.superseded).toContain("idx_image_builds_superseded_cleanup");
    expect(plans.failedArtifact).toContain("idx_image_builds_failed_artifact_cleanup");
    expect(plans.failedHistoryDelete).toContain("idx_image_builds_failed_history_cleanup");
    expect(plans.staleRecovery).toContain("idx_image_builds_stale_recovery");
    expect(plans.finalizationRecovery).toContain("idx_image_builds_finalization_recovery");
    for (const plan of Object.values(plans)) {
      expect(plan).not.toContain("USE TEMP B-TREE");
    }
  });

  it("keeps the authoritative ready image visible beyond the bounded UI history", async () => {
    const environmentId = await seedEnvironment();
    const scope = environmentScope(environmentId);
    const store = new ImageBuildStore(env.DB);

    await store.registerBuild({
      id: "ready-build",
      scope,
      provider: "modal",
      repositoriesFingerprint: "fingerprint-ready",
    });
    await env.DB.prepare(
      `UPDATE image_builds
       SET status = 'ready', runtime_version = 'v53-runtime', created_at = 1
       WHERE id = 'ready-build'`
    ).run();

    for (let index = 0; index < 11; index += 1) {
      const id = `failed-${index}`;
      await store.registerBuild({
        id,
        scope,
        provider: "vercel",
        repositoriesFingerprint: `failed-${index}`,
      });
      await store.markBuildFailed(id, "vercel", "failed");
      await env.DB.prepare("UPDATE image_builds SET created_at = ? WHERE id = ?")
        .bind(100 + index, id)
        .run();
    }

    expect((await store.getStatus(scope)).some((row) => row.id === "ready-build")).toBe(false);
    expect(await store.getReconciliationStatus(scope, "modal")).toEqual([
      expect.objectContaining({ id: "ready-build", status: "ready" }),
    ]);
  });

  it("finalizes an accepted build once and clears cleanup after teardown", async () => {
    const environmentId = await seedEnvironment();
    const store = new ImageBuildStore(env.DB);
    const now = Date.now();
    await store.registerBuild({
      id: "build-finalize",
      scope: environmentScope(environmentId),
      provider: "modal",
      repositoriesFingerprint: "fingerprint-1",
      callbackTokenHash: "token-hash",
      callbackTokenExpiresAt: now + 60_000,
    });
    await store.bindProviderSession("build-finalize", "modal", "session-finalize");
    await store.finalization.acceptSuccessfulCompletion({
      buildId: "build-finalize",
      provider: "modal",
      providerSessionId: "session-finalize",
      tokenHash: "token-hash",
      completionHash: "completion-hash",
      repositoryShas: [{ repoOwner: "acme", repoName: "web", baseSha: "abc123" }],
      runtimeVersion: "v53-runtime",
      buildDurationMs: 12_500,
      now,
    });

    const adapter = {
      startBuild: vi.fn(),
      deleteImage: vi.fn(),
      finalizeSuccessfulBuild: vi.fn(async () => ({
        providerImageId: "image-finalize",
        providerSessionId: "session-finalize",
      })),
      cleanupCompletedBuild: vi.fn(async () => undefined),
      cleanupFailedBuild: vi.fn(async () => undefined),
    };
    const finalizer = new ImageBuildFinalizer(store, {
      create: vi.fn(() => adapter),
    });
    const job = {
      version: 1 as const,
      buildId: "build-finalize",
      completionHash: "completion-hash",
    };

    expect(await finalizer.process(job, { request_id: "queue-1", trace_id: "queue-1" })).toEqual({
      type: "completed",
    });
    expect(await finalizer.process(job, { request_id: "queue-2", trace_id: "queue-2" })).toEqual({
      type: "completed",
    });

    const row = await getRow("build-finalize");
    expect(row?.status).toBe("ready");
    expect(row?.provider_image_id).toBe("image-finalize");
    expect(row?.provider_session_cleanup_pending).toBe(0);
    expect(row?.finalization_lease_token).toBeNull();
    expect(adapter.finalizeSuccessfulBuild).toHaveBeenCalledTimes(1);
    expect(adapter.cleanupCompletedBuild).toHaveBeenCalledTimes(1);
  });

  it("allows a redelivery to recover an expired finalization lease", async () => {
    const environmentId = await seedEnvironment();
    const store = new ImageBuildStore(env.DB);
    const now = Date.now();
    await store.registerBuild({
      id: "build-crashed-lease",
      scope: environmentScope(environmentId),
      provider: "modal",
      repositoriesFingerprint: "fingerprint-1",
      callbackTokenHash: "token-hash",
      callbackTokenExpiresAt: now + 60_000,
    });
    await store.bindProviderSession("build-crashed-lease", "modal", "session-1");
    await store.finalization.acceptSuccessfulCompletion({
      buildId: "build-crashed-lease",
      provider: "modal",
      providerSessionId: "session-1",
      tokenHash: "token-hash",
      completionHash: "completion-hash",
      repositoryShas: [],
      runtimeVersion: "v53-runtime",
      buildDurationMs: 1,
      now,
    });

    expect(
      await store.finalization.claimLease({
        buildId: "build-crashed-lease",
        completionHash: "completion-hash",
        leaseToken: "consumer-1",
        now: 100,
        expiresAt: 200,
      })
    ).toBe(true);
    expect(
      await store.finalization.claimLease({
        buildId: "build-crashed-lease",
        completionHash: "completion-hash",
        leaseToken: "consumer-2",
        now: 199,
        expiresAt: 299,
      })
    ).toBe(false);
    expect(
      await store.finalization.claimLease({
        buildId: "build-crashed-lease",
        completionHash: "completion-hash",
        leaseToken: "consumer-2",
        now: 200,
        expiresAt: 300,
      })
    ).toBe(true);
  });
});
