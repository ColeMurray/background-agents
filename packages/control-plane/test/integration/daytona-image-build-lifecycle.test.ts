import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import { ImageBuildStore } from "../../src/db/image-builds";
import { DaytonaImageBuildAdapter } from "../../src/image-builds/daytona-adapter";
import { DaytonaImageBuildResources } from "../../src/image-builds/daytona-build-resources";
import { ImageBuildFinalizer } from "../../src/image-builds/finalizer";
import { ImageBuildWorkflow } from "../../src/image-builds/workflow";
import type { ImageBuildPlannerPort } from "../../src/image-builds/planner";
import {
  DaytonaApiError,
  DaytonaNotFoundError,
  type DaytonaRestClient,
} from "../../src/sandbox/daytona-rest-client";
import { cleanD1Tables } from "./cleanup";
import {
  environmentScope,
  getRow,
  seedEnvironment,
  RUNTIME_VERSION,
  REPOSITORY_SHAS,
} from "./image-build-helpers";

const correlation = { request_id: "daytona-lifecycle", trace_id: "daytona-lifecycle" };
const completionHash = "a".repeat(64);
beforeEach(cleanD1Tables);
afterEach(() => vi.restoreAllMocks());

async function accept(store: ImageBuildStore, buildId: string) {
  expect(
    await store.finalization.acceptSuccessfulCompletion({
      buildId,
      provider: "daytona",
      providerSessionId: "source-1",
      tokenHash: "token-hash",
      completionHash,
      repositoryShas: REPOSITORY_SHAS,
      runtimeVersion: RUNTIME_VERSION,
      buildDurationSeconds: 0.1,
      now: Date.now(),
    })
  ).toBe("accepted");
}

it.each([429, 503, "request-timeout"] as const)(
  "keeps a reserved capture retryable after a snapshot read %s",
  async (failure) => {
    const store = new ImageBuildStore(env.DB);
    const buildId = "read-failure";
    await store.registerBuild({
      id: buildId,
      scope: environmentScope(await seedEnvironment()),
      provider: "daytona",
      repositoriesFingerprint: "fp",
      callbackTokenHash: "token-hash",
      callbackTokenExpiresAt: Date.now() + 60_000,
    });
    await store.bindProviderSession(buildId, "daytona", "source-1");
    await accept(store, buildId);
    const deadlineAt = Date.now() + 600_000;
    await env.DB.prepare(
      "UPDATE image_builds SET provider_operation_ref = ?, provider_operation_deadline_at = ? WHERE id = ?"
    )
      .bind("reserved-image", deadlineAt, buildId)
      .run();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const resources = {
      getBuildSnapshot: vi.fn(async () => {
        // Spend one observation window without waiting on wall-clock timers.
        now += 90_001;
        if (failure === "request-timeout")
          throw new DOMException("The operation was aborted", "AbortError");
        throw new DaytonaApiError("temporary provider failure", failure);
      }),
      deleteBuildSandbox: vi.fn(async () => {}),
    };
    const adapter = new DaytonaImageBuildAdapter(
      resources as unknown as DaytonaImageBuildResources
    );
    const result = await new ImageBuildFinalizer(store, { create: () => adapter }).process(
      { version: 1, buildId, completionHash },
      correlation
    );
    const row = await getRow(buildId);
    expect(result).toMatchObject({ type: "retry", reason: "pending_operation" });
    expect(row).toMatchObject({
      status: "building",
      provider_operation_ref: "reserved-image",
      provider_operation_deadline_at: deadlineAt,
      finalization_lease_token: null,
    });
    expect(resources.deleteBuildSandbox).not.toHaveBeenCalled();
  }
);

it.each(["probe-unavailable", "probe-exited", "stdin-response-lost"])(
  "preserves accepted completion after %s during capture",
  async (failure) => {
    const store = new ImageBuildStore(env.DB);
    const scope = environmentScope(await seedEnvironment());
    let buildId = "";
    let sourceState = "started";
    let deleted = false;
    let captureStarted!: () => void;
    const captureSubmitted = new Promise<void>((resolve) => {
      captureStarted = resolve;
    });
    let finalizing: Promise<unknown> | undefined;
    let finishCapture!: (value: {
      id: string;
      name: string;
      state: string;
      sourceSandboxId: string;
    }) => void;
    const captured = new Promise<{
      id: string;
      name: string;
      state: string;
      sourceSandboxId: string;
    }>((resolve) => {
      finishCapture = resolve;
    });
    const client = {
      config: { baseSnapshot: "base" },
      requireBaseSnapshot: () => "base",
      createSandbox: vi.fn(async () => ({ id: "source-1", state: "started" })),
      getSandbox: vi.fn(async () => {
        if (deleted) throw new DaytonaNotFoundError("source deleted");
        return {
          id: "source-1",
          state: sourceState,
          labels: {
            openinspect_framework: "open-inspect",
            openinspect_kind: "environment-image-build",
            openinspect_build_id: buildId,
            openinspect_expires_at: String(Date.now() + 3_600_000),
          },
        };
      }),
      resolveToolboxBaseUrl: async () => "https://toolbox.test",
      createProcessSession: async () => {},
      executeSessionCommand: async () => ({ cmdId: "command-1" }),
      sendSessionCommandInput: async () => {
        await accept(store, buildId);
        finalizing = finalizer.process({ version: 1, buildId, completionHash }, correlation);
        // Complete the provider's stop and capture submission before returning
        // from stdin delivery, modeling a fast clone/setup and queue delivery.
        await captureSubmitted;
        if (failure === "stdin-response-lost") throw new TypeError("fetch failed");
      },
      getSessionCommand: async () => {
        expect(sourceState).toBe("stopped");
        if (failure === "probe-exited") return { id: "command-1", exitCode: 137 };
        throw new DaytonaApiError("toolbox unavailable while source is stopped", 503);
      },
      stopSandbox: async () => {
        sourceState = "stopped";
      },
      createSandboxSnapshot: async () => {
        captureStarted();
        return { id: "source-1", state: "snapshotting" };
      },
      getSnapshot: async () => captured,
      deleteSandbox: vi.fn(async () => {
        deleted = true;
      }),
    };
    const resources = new DaytonaImageBuildResources(client as unknown as DaytonaRestClient, {
      scmProvider: "github",
    });
    const adapter = new DaytonaImageBuildAdapter(resources);
    const factory = { create: () => adapter };
    const finalizer = new ImageBuildFinalizer(store, factory);
    const repositories = [{ repoOwner: "acme", repoName: "web", baseBranch: "main" }];
    const planner: ImageBuildPlannerPort = {
      resolveTarget: async () => ({
        kind: "environment" as const,
        repositories,
        repositoriesFingerprint: "fp",
      }),
      createCallbackAuth: async () => ({
        token: "b".repeat(64),
        tokenHash: "token-hash",
        expiresAt: Date.now() + 60_000,
      }),
      planBuild: async (params) => {
        buildId = params.buildId;
        return {
          ...params,
          scope,
          repositories,
          repositoriesFingerprint: "fp",
          callbackToken: "b".repeat(64),
          buildTimeoutMs: 1_800_000,
          correlation,
          cloneAuth: { type: "unavailable" as const },
        };
      },
    };
    const workflow = new ImageBuildWorkflow(
      createCloudflareEnv({
        ...env,
        SANDBOX_PROVIDER: "daytona",
        DAYTONA_PREBUILDS_ENABLED: "true",
        WORKER_URL: "https://worker.test",
      }),
      store,
      factory,
      { provider: "daytona", planner }
    );
    const result = await workflow
      .triggerBuild(scope, correlation)
      .catch((error: Error) => ({ error: error.message }));
    const row = await getRow(buildId);
    const deletedBeforeCapture = deleted;
    finishCapture({
      id: "image-1",
      name: "reserved",
      state: "active",
      sourceSandboxId: "source-1",
    });
    await finalizing;
    expect(result).toMatchObject({ type: "triggered" });
    expect(row?.status).toBe("building");
    expect(row?.callback_token_used_at).not.toBeNull();
    expect(deletedBeforeCapture).toBe(false);
    expect(await getRow(buildId)).toMatchObject({ status: "ready", provider_image_id: "image-1" });
  },
  15_000
);

it("fences a late callback when trigger failure wins first", async () => {
  const store = new ImageBuildStore(env.DB);
  const buildId = "failed-trigger";
  await store.registerBuild({
    id: buildId,
    scope: environmentScope(await seedEnvironment()),
    provider: "daytona",
    repositoriesFingerprint: "fp",
    callbackTokenHash: "token-hash",
    callbackTokenExpiresAt: Date.now() + 60_000,
  });
  await store.bindProviderSession(buildId, "daytona", "source-1");
  expect(await store.markBuildFailed(buildId, "daytona", "launcher rejected context")).toBe(true);
  expect(
    await store.finalization.acceptSuccessfulCompletion({
      buildId,
      provider: "daytona",
      providerSessionId: "source-1",
      tokenHash: "token-hash",
      completionHash,
      repositoryShas: REPOSITORY_SHAS,
      runtimeVersion: RUNTIME_VERSION,
      buildDurationSeconds: 0.1,
      now: Date.now(),
    })
  ).toBe("rejected");
  expect(await getRow(buildId)).toMatchObject({ status: "failed", callback_token_used_at: null });
});
