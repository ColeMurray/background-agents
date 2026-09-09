/**
 * Lazy trigger-time stale recovery over real D1: a `building` row whose
 * sandbox died without a callback would hold the concurrency-1 guard forever
 * (getActiveBuild has no age cutoff), so the workflow fails timed-out rows for
 * the triggering scope before the in-flight check. Kept separate from the
 * image-build lifecycle suite (image-builds.test.ts): these tests wire a real
 * ImageBuildWorkflow over the shared D1 binding, and each integration file
 * gets its own isolated D1 instance.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { ImageBuildStore } from "../../src/db/image-builds";
import { DEFAULT_STALE_BUILD_MAX_AGE_MS } from "../../src/image-builds/maintenance";
import type { ImageBuildScope } from "../../src/image-builds/model";
import type { ImageBuildAdapterFactory } from "../../src/image-builds/provider-factory";
import type { ImageBuildAdapter } from "../../src/image-builds/types";
import { ImageBuildWorkflow } from "../../src/image-builds/workflow";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import { cleanD1Tables } from "./cleanup";
import { environmentScope, getRow, seedEnvironment, seedImageRow } from "./image-build-helpers";

const TWO_HOURS_AGO = () => Date.now() - 2 * 60 * 60 * 1000;

/**
 * Workflow wired to the real D1 store with the provider layers stubbed
 * out (the harness has no live provider): a no-op adapter and a planner
 * echoing a fixed modal plan. The casts confine the stub shapes to this
 * one seam.
 */
function createTriggerWorkflow(scope: ImageBuildScope): ImageBuildWorkflow {
  const adapter = { async startBuild() {} } as unknown as ImageBuildAdapter;
  const factory = { create: () => adapter } as ImageBuildAdapterFactory;
  const planner = {
    resolveTarget: async () => ({
      repositories: [{ repoOwner: "acme", repoName: "web", baseBranch: "main" }],
      repositoriesFingerprint: "fp-heal",
    }),
    createCallbackAuth: async () => ({ kind: "none" }),
    planBuild: async () => ({
      plan: {
        buildId: "imgb-heal-plan",
        scope,
        repositories: [{ repoOwner: "acme", repoName: "web", baseBranch: "main" }],
        repositoriesFingerprint: "fp-heal",
        callbackUrl: "https://worker.test/image-builds/build-complete",
        failureCallbackUrl: "https://worker.test/image-builds/build-failed",
        buildTimeoutMs: 1800_000,
        correlation: { trace_id: "trace-heal", request_id: "req-heal" },
        provider: "modal",
      },
      callbackAuth: { type: "none" },
    }),
  } as unknown as NonNullable<ConstructorParameters<typeof ImageBuildWorkflow>[3]>["planner"];
  return new ImageBuildWorkflow(
    createCloudflareEnv({ ...env, WORKER_URL: "https://worker.test" }),
    new ImageBuildStore(env.DB),
    factory,
    { provider: "modal", planner },
    { send: async () => undefined }
  );
}

describe("lazy trigger-time stale recovery over real D1", () => {
  beforeEach(cleanD1Tables);

  it("markScopeStaleBuildFailed fails only the scope+provider's timed-out building rows", async () => {
    const environmentId = await seedEnvironment();
    const otherEnvironmentId = await seedEnvironment();
    await seedImageRow({
      id: "lazy-stale",
      environmentId,
      status: "building",
      createdAt: TWO_HOURS_AGO(),
    });
    await seedImageRow({ id: "lazy-fresh", environmentId, status: "building" });
    await seedImageRow({
      id: "lazy-other-scope",
      environmentId: otherEnvironmentId,
      status: "building",
      createdAt: TWO_HOURS_AGO(),
    });
    await seedImageRow({
      id: "lazy-other-provider",
      environmentId,
      status: "building",
      provider: "vercel",
      createdAt: TWO_HOURS_AGO(),
    });

    const marked = await new ImageBuildStore(env.DB).markScopeStaleBuildFailed(
      environmentScope(environmentId),
      "modal",
      DEFAULT_STALE_BUILD_MAX_AGE_MS
    );

    expect(marked).toBe(1);
    const stale = await getRow("lazy-stale");
    expect(stale?.status).toBe("failed");
    expect(stale?.error_message).toBe("build timed out (no callback received)");
    expect((await getRow("lazy-fresh"))?.status).toBe("building");
    expect((await getRow("lazy-other-scope"))?.status).toBe("building");
    expect((await getRow("lazy-other-provider"))?.status).toBe("building");
  });

  it("does not stale-fail a callback accepted for asynchronous finalization", async () => {
    const environmentId = await seedEnvironment();
    await seedImageRow({
      id: "accepted-finalization",
      environmentId,
      status: "building",
      createdAt: TWO_HOURS_AGO(),
    });
    await env.DB.prepare(
      `UPDATE image_builds
       SET callback_token_used_at = ?, completion_hash = 'accepted-hash'
       WHERE id = 'accepted-finalization'`
    )
      .bind(Date.now())
      .run();

    const store = new ImageBuildStore(env.DB);
    expect(
      await store.markScopeStaleBuildFailed(
        environmentScope(environmentId),
        "modal",
        DEFAULT_STALE_BUILD_MAX_AGE_MS
      )
    ).toBe(0);
    expect(await store.markStaleBuildsAsFailed(DEFAULT_STALE_BUILD_MAX_AGE_MS)).toBe(0);
    expect((await getRow("accepted-finalization"))?.status).toBe("building");
  });

  it("leaves an old accepted callback recoverable instead of stale-failing it", async () => {
    const environmentId = await seedEnvironment();
    await seedImageRow({
      id: "exhausted-finalization",
      environmentId,
      status: "building",
      createdAt: TWO_HOURS_AGO(),
    });
    await env.DB.prepare(
      `UPDATE image_builds
       SET callback_token_used_at = ?, completion_hash = 'accepted-hash'
       WHERE id = 'exhausted-finalization'`
    )
      .bind(TWO_HOURS_AGO())
      .run();

    expect(
      await new ImageBuildStore(env.DB).markStaleBuildsAsFailed(DEFAULT_STALE_BUILD_MAX_AGE_MS)
    ).toBe(0);
    expect(await getRow("exhausted-finalization")).toMatchObject({
      status: "building",
      completion_hash: "accepted-hash",
    });
  });

  it("marks every globally stale build in one maintenance scan", async () => {
    const environmentId = await seedEnvironment();
    for (let index = 0; index < 30; index += 1) {
      await seedImageRow({
        id: `stale-${String(index).padStart(2, "0")}`,
        environmentId,
        status: "building",
        createdAt: index + 1,
      });
    }

    expect(
      await new ImageBuildStore(env.DB).markStaleBuildsAsFailed(DEFAULT_STALE_BUILD_MAX_AGE_MS)
    ).toBe(30);
    const remaining = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM image_builds WHERE status = 'building'"
    ).first<{ count: number }>();
    expect(remaining?.count).toBe(0);
  });

  it("triggerBuild heals a wedged scope: dead row failed, fresh build registered", async () => {
    const environmentId = await seedEnvironment();
    const scope = environmentScope(environmentId);
    await seedImageRow({
      id: "wedged",
      environmentId,
      status: "building",
      createdAt: TWO_HOURS_AGO(),
    });

    const workflow = createTriggerWorkflow(scope);

    const result = await workflow.triggerBuild(scope, {
      request_id: "req-heal",
      trace_id: "trace-heal",
    });

    expect(result.type).toBe("triggered");
    if (result.type !== "triggered") throw new Error("unreachable");
    expect((await getRow("wedged"))?.status).toBe("failed");
    expect((await getRow(result.buildId))?.status).toBe("building");
  });

  it("triggerBuild still yields to a live in-flight build", async () => {
    const environmentId = await seedEnvironment();
    await seedImageRow({ id: "live-build", environmentId, status: "building" });

    const workflow = createTriggerWorkflow(environmentScope(environmentId));

    await expect(
      workflow.triggerBuild(environmentScope(environmentId), {
        request_id: "req-live",
        trace_id: "trace-live",
      })
    ).resolves.toEqual({ type: "already_building", buildId: "live-build" });
    expect((await getRow("live-build"))?.status).toBe("building");
  });
});
