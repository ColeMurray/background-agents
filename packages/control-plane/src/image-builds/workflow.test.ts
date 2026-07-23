import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateInternalToken } from "../auth/internal";
import type { ImageBuildStore } from "../db/image-builds";
import type { Env } from "../types";
import {
  ImageBuildCallbackAuthRejectedError,
  ImageBuildCompletionNotAcceptedError,
  ImageBuildFailureNotAcceptedError,
  ImageBuildInvalidCallbackError,
  ImageBuildScopeNotFoundError,
  ImageBuildTriggerFailedError,
  ImageBuildWorkflowUnavailableError,
} from "./errors";
import { DEFAULT_STALE_BUILD_MAX_AGE_MS } from "./maintenance";
import type { ImageBuildScope } from "./model";
import type { ImageBuildAdapterFactory } from "./provider-factory";
import type { PlannedImageBuild } from "./types";
import { ImageBuildWorkflow } from "./workflow";

const INTERNAL_SECRET = "test-internal-secret";

const ENV_SCOPE: ImageBuildScope = { kind: "environment", id: "env_1" };

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    WORKER_URL: "https://worker.test",
    INTERNAL_CALLBACK_SECRET: INTERNAL_SECRET,
    ...overrides,
  } as Env;
}

function createStore() {
  return {
    registerBuild: vi.fn().mockResolvedValue(true),
    getActiveBuild: vi.fn().mockResolvedValue(null),
    markScopeStaleBuildFailed: vi.fn().mockResolvedValue(0),
    hasReadyImageForFingerprint: vi.fn().mockResolvedValue(false),
    getCallbackBuild: vi.fn().mockResolvedValue(null),
    getBuildRow: vi.fn().mockResolvedValue(null),
    recordArtifactOnSupersededBuild: vi.fn().mockResolvedValue(true),
    bindProviderSession: vi.fn().mockResolvedValue(true),
    verifyCallbackToken: vi.fn().mockResolvedValue(false),
    consumeCallbackToken: vi.fn().mockResolvedValue(null),
    markBuildFailedWithCallbackToken: vi.fn().mockResolvedValue(false),
    tryMarkImageBuildReady: vi.fn(),
    markBuildFailed: vi.fn().mockResolvedValue(true),
    deleteSupersededImage: vi.fn().mockResolvedValue(true),
    supersedeActiveImages: vi.fn().mockResolvedValue(0),
    getSupersededImages: vi.fn().mockResolvedValue([]),
    getFailedImagesWithArtifacts: vi.fn().mockResolvedValue([]),
    clearFailedImageArtifact: vi.fn().mockResolvedValue(true),
    deleteOldFailedBuilds: vi.fn().mockResolvedValue(0),
    markStaleBuildsAsFailed: vi.fn().mockResolvedValue(0),
    getStatus: vi.fn().mockResolvedValue([]),
    getStatusForEnabledScopes: vi.fn().mockResolvedValue([]),
  };
}

function createAdapter() {
  return {
    startBuild: vi.fn().mockResolvedValue(undefined),
    deleteImage: vi.fn().mockResolvedValue(undefined),
    finalizeSuccessfulBuild: vi.fn().mockResolvedValue({
      providerImageId: "im-finalized",
      providerSessionId: "vercel-session-1",
    }),
    cleanupFailedBuild: vi.fn().mockResolvedValue(undefined),
    cleanupCompletedBuild: vi.fn().mockResolvedValue(undefined),
  };
}

function plannedBuild(overrides: Record<string, unknown> = {}): PlannedImageBuild {
  return {
    plan: {
      buildId: "imgb-env_1-1-abcd",
      scope: ENV_SCOPE,
      repositories: [{ repoOwner: "acme", repoName: "web", baseBranch: "main" }],
      repositoriesFingerprint: "fp-1",
      callbackUrl: "https://worker.test/image-builds/build-complete",
      failureCallbackUrl: "https://worker.test/image-builds/build-failed",
      buildTimeoutMs: 1800_000,
      correlation: { trace_id: "t", request_id: "r" },
      provider: "modal",
      callbackMode: "provider_image",
      ...overrides,
    },
    callbackAuth: { type: "none" },
  };
}

function vercelPlannedBuild(): PlannedImageBuild {
  return {
    plan: {
      buildId: "imgb-env_1-1-abcd",
      scope: ENV_SCOPE,
      repositories: [{ repoOwner: "acme", repoName: "web", baseBranch: "main" }],
      repositoriesFingerprint: "fp-1",
      callbackUrl: "https://worker.test/image-builds/build-complete",
      failureCallbackUrl: "https://worker.test/image-builds/build-failed",
      buildTimeoutMs: 1800_000,
      correlation: { trace_id: "t", request_id: "r" },
      provider: "vercel",
      callbackMode: "provider_session",
      callbackToken: "callback-token",
      cloneAuth: { type: "unavailable" },
    },
    callbackAuth: { type: "bearer_token", tokenHash: "hash-1", expiresAt: 9_999_999_999_999 },
  };
}

function createWorkflow(options: {
  store?: ReturnType<typeof createStore>;
  adapter?: ReturnType<typeof createAdapter>;
  planBuild?: ReturnType<typeof vi.fn>;
  resolveTarget?: ReturnType<typeof vi.fn>;
  createCallbackAuth?: ReturnType<typeof vi.fn>;
  env?: Env;
  provider?: "modal" | "vercel" | "opencomputer" | null;
}) {
  const store = options.store ?? createStore();
  const adapter = options.adapter ?? createAdapter();
  const factory: ImageBuildAdapterFactory = {
    create: vi.fn().mockReturnValue(adapter),
  };
  const planBuild = options.planBuild ?? vi.fn().mockResolvedValue(plannedBuild());
  const resolveTarget =
    options.resolveTarget ??
    vi.fn().mockResolvedValue({
      repositories: [{ repoOwner: "acme", repoName: "web", baseBranch: "main" }],
      repositoriesFingerprint: "fp-1",
    });
  const createCallbackAuth =
    options.createCallbackAuth ?? vi.fn().mockResolvedValue({ kind: "none" });
  const provider = options.provider === undefined ? "modal" : options.provider;
  const planner = { planBuild, resolveTarget, createCallbackAuth } as unknown as NonNullable<
    ConstructorParameters<typeof ImageBuildWorkflow>[3]
  >["planner"];
  const workflow = new ImageBuildWorkflow(
    options.env ?? createEnv(),
    store as unknown as ImageBuildStore,
    factory,
    provider ? { provider, planner } : null
  );
  return { workflow, store, adapter, factory, planBuild, resolveTarget, createCallbackAuth };
}

const ctx = { trace_id: "t", request_id: "r" };

async function validAuthHeader(): Promise<string> {
  return `Bearer ${await generateInternalToken(INTERNAL_SECRET)}`;
}

function validCompletion(overrides: Record<string, unknown> = {}) {
  return {
    buildId: "imgb-env_1-1-abcd",
    providerImageId: "im-modal-1",
    repositoryShas: [{ repoOwner: "acme", repoName: "web", baseSha: "abc123" }],
    runtimeVersion: "v53-list-native-runtime",
    buildDurationMs: 12_500,
    ...overrides,
  };
}

describe("ImageBuildWorkflow", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("triggerBuild", () => {
    it("plans, registers, and starts a build", async () => {
      const { workflow, store, adapter } = createWorkflow({});

      const result = await workflow.triggerBuild(ENV_SCOPE, ctx);

      expect(result.type).toBe("triggered");
      if (result.type !== "triggered") throw new Error("unreachable");
      expect(result.buildId).toMatch(/^imgb-env_1-\d+-/);
      expect(store.registerBuild).toHaveBeenCalledWith({
        id: result.buildId,
        scope: ENV_SCOPE,
        provider: "modal",
        repositoriesFingerprint: "fp-1",
      });
      expect(adapter.startBuild).toHaveBeenCalledTimes(1);
    });

    it("reports the in-flight build instead of stacking another", async () => {
      const store = createStore();
      store.getActiveBuild.mockResolvedValue({ id: "imgb-existing" });
      const { workflow, planBuild } = createWorkflow({ store });

      const result = await workflow.triggerBuild(ENV_SCOPE, ctx);

      expect(result).toEqual({ type: "already_building", buildId: "imgb-existing" });
      expect(planBuild).not.toHaveBeenCalled();
      expect(store.registerBuild).not.toHaveBeenCalled();
    });

    it("lazily fails a timed-out build before the in-flight check", async () => {
      const store = createStore();
      store.markScopeStaleBuildFailed.mockResolvedValue(1);
      const { workflow } = createWorkflow({ store });

      const result = await workflow.triggerBuild(ENV_SCOPE, ctx);

      expect(result.type).toBe("triggered");
      expect(store.markScopeStaleBuildFailed).toHaveBeenCalledWith(
        ENV_SCOPE,
        "modal",
        DEFAULT_STALE_BUILD_MAX_AGE_MS
      );
      // The wedged row must be failed before the in-flight read, or the read
      // still sees it and re-wedges the scope.
      expect(store.markScopeStaleBuildFailed.mock.invocationCallOrder[0]).toBeLessThan(
        store.getActiveBuild.mock.invocationCallOrder[0]
      );
    });

    it("still reports a fresh in-flight build after the lazy stale check", async () => {
      const store = createStore();
      store.getActiveBuild.mockResolvedValue({ id: "imgb-fresh" });
      const { workflow, planBuild } = createWorkflow({ store });

      const result = await workflow.triggerBuild(ENV_SCOPE, ctx);

      expect(result).toEqual({ type: "already_building", buildId: "imgb-fresh" });
      expect(store.markScopeStaleBuildFailed).toHaveBeenCalled();
      expect(planBuild).not.toHaveBeenCalled();
    });

    it("a lazy stale-mark failure never blocks the in-flight report", async () => {
      const store = createStore();
      store.markScopeStaleBuildFailed.mockRejectedValue(new Error("D1 unavailable"));
      store.getActiveBuild.mockResolvedValue({ id: "imgb-existing" });
      const { workflow } = createWorkflow({ store });

      const result = await workflow.triggerBuild(ENV_SCOPE, ctx);

      expect(result).toEqual({ type: "already_building", buildId: "imgb-existing" });
    });

    it("a lazy stale-mark failure never blocks a fresh trigger", async () => {
      const store = createStore();
      store.markScopeStaleBuildFailed.mockRejectedValue(new Error("D1 unavailable"));
      const { workflow } = createWorkflow({ store });

      const result = await workflow.triggerBuild(ENV_SCOPE, ctx);

      expect(result.type).toBe("triggered");
      expect(store.registerBuild).toHaveBeenCalled();
    });

    it("yields to a concurrent trigger that wins the registerBuild guard", async () => {
      // The getActiveBuild read races: both triggers can pass it, but the
      // registerBuild NOT EXISTS guard admits exactly one. The loser must
      // report the winner's build, not start provider work.
      const store = createStore();
      store.getActiveBuild
        .mockResolvedValueOnce(null) // pre-register short-circuit: nothing yet
        .mockResolvedValueOnce({ id: "imgb-winner" }); // re-read after losing
      store.registerBuild.mockResolvedValue(false);
      const { workflow, adapter, planBuild } = createWorkflow({ store });

      const result = await workflow.triggerBuild(ENV_SCOPE, ctx);

      expect(result).toEqual({ type: "already_building", buildId: "imgb-winner" });
      expect(planBuild).not.toHaveBeenCalled();
      expect(adapter.startBuild).not.toHaveBeenCalled();
      // The loser's phantom id must not be failed — no row was written.
      expect(store.markBuildFailed).not.toHaveBeenCalled();
    });

    it("propagates environment-not-found from target resolution without writing a row", async () => {
      const resolveTarget = vi
        .fn()
        .mockRejectedValue(new ImageBuildScopeNotFoundError("environment", "env_missing"));
      const { workflow, store } = createWorkflow({ resolveTarget });

      await expect(
        workflow.triggerBuild({ kind: "environment", id: "env_missing" }, ctx)
      ).rejects.toBeInstanceOf(ImageBuildScopeNotFoundError);
      expect(store.registerBuild).not.toHaveBeenCalled();
    });

    it("registers the build row before secrets are read (§7.4 supersede window)", async () => {
      const { workflow, store, planBuild } = createWorkflow({});

      await workflow.triggerBuild(ENV_SCOPE, ctx);

      // planBuild is where secrets are decrypted; a concurrent secret change
      // must always find a row to supersede.
      expect(store.registerBuild.mock.invocationCallOrder[0]).toBeLessThan(
        planBuild.mock.invocationCallOrder[0]
      );
    });

    it("fails a misconfigured provider closed without writing a row", async () => {
      const factoryError = vi.fn(() => {
        throw new Error("MODAL_WORKSPACE not configured");
      });
      const store = createStore();
      const adapter = createAdapter();
      const workflow = new ImageBuildWorkflow(
        createEnv(),
        store as unknown as ImageBuildStore,
        { create: factoryError },
        {
          provider: "modal",
          planner: {
            planBuild: vi.fn(),
            resolveTarget: vi.fn().mockResolvedValue({
              repositories: [{ repoOwner: "acme", repoName: "web", baseBranch: "main" }],
              repositoriesFingerprint: "fp-1",
            }),
            createCallbackAuth: vi.fn().mockResolvedValue({ kind: "none" }),
          } as unknown as NonNullable<
            ConstructorParameters<typeof ImageBuildWorkflow>[3]
          >["planner"],
        }
      );

      await expect(workflow.triggerBuild(ENV_SCOPE, ctx)).rejects.toMatchObject({
        code: "provider_unconfigured",
      });
      // No junk failed rows accumulate from a misconfigured provider.
      expect(store.registerBuild).not.toHaveBeenCalled();
      expect(adapter.startBuild).not.toHaveBeenCalled();
    });

    it("marks the build failed when the adapter cannot start it", async () => {
      const adapter = createAdapter();
      adapter.startBuild.mockRejectedValue(new Error("modal down"));
      const { workflow, store } = createWorkflow({ adapter });

      await expect(workflow.triggerBuild(ENV_SCOPE, ctx)).rejects.toBeInstanceOf(
        ImageBuildTriggerFailedError
      );
      expect(store.markBuildFailed).toHaveBeenCalledWith(
        expect.stringMatching(/^imgb-env_1-/),
        "modal",
        "modal down"
      );
    });

    it("is unavailable without a provider", async () => {
      const { workflow } = createWorkflow({ provider: null });

      await expect(workflow.triggerBuild(ENV_SCOPE, ctx)).rejects.toBeInstanceOf(
        ImageBuildWorkflowUnavailableError
      );
    });

    it("is unavailable without WORKER_URL", async () => {
      const { workflow } = createWorkflow({ env: createEnv({ WORKER_URL: undefined }) });

      await expect(workflow.triggerBuild(ENV_SCOPE, ctx)).rejects.toBeInstanceOf(
        ImageBuildWorkflowUnavailableError
      );
    });
  });

  describe("repo scopes flow through the same machinery", () => {
    const REPO_SCOPE: ImageBuildScope = { kind: "repo", id: "acme/web" };

    it("registers and starts a repo-scope build under the unified id scheme", async () => {
      const { workflow, store } = createWorkflow({});

      const result = await workflow.triggerBuild(REPO_SCOPE, ctx);

      expect(result.type).toBe("triggered");
      if (result.type !== "triggered") throw new Error("unreachable");
      // One prefix for every scope kind; the repo scope id's `/` flattens so
      // build ids stay safe as path segments and provider labels.
      expect(result.buildId).toMatch(/^imgb-acme-web-\d+-/);
      expect(store.registerBuild).toHaveBeenCalledWith(
        expect.objectContaining({ scope: REPO_SCOPE, provider: "modal" })
      );
    });

    it("enforces concurrency-1 on a repo scope: a second trigger reports the in-flight build", async () => {
      // Deliberate behavior change: the old repo subsystem stacked concurrent
      // builds and raced them to mark-ready.
      const store = createStore();
      store.getActiveBuild.mockResolvedValue({ id: "imgb-acme-web-existing" });
      const { workflow, planBuild } = createWorkflow({ store });

      const result = await workflow.triggerBuild(REPO_SCOPE, ctx);

      expect(result).toEqual({ type: "already_building", buildId: "imgb-acme-web-existing" });
      expect(store.registerBuild).not.toHaveBeenCalled();
      expect(planBuild).not.toHaveBeenCalled();
    });

    it("registers the repo build row before secrets are read (§7.4 supersede window)", async () => {
      // Deliberate behavior change: the old repo planner decrypted secrets
      // before any row existed, leaving a secret change nothing to supersede.
      const { workflow, store, planBuild } = createWorkflow({});

      await workflow.triggerBuild(REPO_SCOPE, ctx);

      expect(store.registerBuild.mock.invocationCallOrder[0]).toBeLessThan(
        planBuild.mock.invocationCallOrder[0]
      );
    });

    it("propagates repo-not-installed from target resolution without writing a row", async () => {
      const resolveTarget = vi
        .fn()
        .mockRejectedValue(new ImageBuildScopeNotFoundError("repo", "acme/web"));
      const { workflow, store } = createWorkflow({ resolveTarget });

      await expect(workflow.triggerBuild(REPO_SCOPE, ctx)).rejects.toBeInstanceOf(
        ImageBuildScopeNotFoundError
      );
      expect(store.registerBuild).not.toHaveBeenCalled();
    });
  });

  describe("triggerBuildIfStale", () => {
    it("skips when a ready image matches the current fingerprint", async () => {
      const store = createStore();
      store.hasReadyImageForFingerprint.mockResolvedValue(true);
      const { workflow, planBuild } = createWorkflow({ store });

      const result = await workflow.triggerBuildIfStale(ENV_SCOPE, ctx);

      expect(result).toEqual({ type: "up_to_date" });
      expect(store.hasReadyImageForFingerprint).toHaveBeenCalledWith(ENV_SCOPE, "modal", "fp-1");
      expect(store.registerBuild).not.toHaveBeenCalled();
      // A no-op save must not decrypt secrets or mint clone tokens.
      expect(planBuild).not.toHaveBeenCalled();
    });

    it("builds when no ready image matches", async () => {
      const { workflow, store } = createWorkflow({});

      const result = await workflow.triggerBuildIfStale(ENV_SCOPE, ctx);

      expect(result.type).toBe("triggered");
      expect(store.registerBuild).toHaveBeenCalledTimes(1);
    });
  });

  describe("acceptBuildComplete", () => {
    function readyBuildStore() {
      const store = createStore();
      store.getCallbackBuild.mockResolvedValue({
        id: "imgb-env_1-1-abcd",
        scope: ENV_SCOPE,
        provider: "modal",
        providerSessionId: null,
        status: "building",
      });
      return store;
    }

    it("rejects unknown builds", async () => {
      const { workflow } = createWorkflow({});

      await expect(
        workflow.acceptBuildComplete({
          completion: validCompletion(),
          authorizationHeader: await validAuthHeader(),
          context: ctx,
        })
      ).rejects.toBeInstanceOf(ImageBuildCompletionNotAcceptedError);
    });

    it("rejects bad internal auth", async () => {
      const { workflow } = createWorkflow({ store: readyBuildStore() });

      await expect(
        workflow.acceptBuildComplete({
          completion: validCompletion(),
          authorizationHeader: "Bearer forged",
          context: ctx,
        })
      ).rejects.toBeInstanceOf(ImageBuildCallbackAuthRejectedError);
    });

    it.each([
      ["missing provider_image_id", { providerImageId: undefined }],
      ["missing repository_shas", { repositoryShas: undefined }],
      ["empty repository_shas", { repositoryShas: [] }],
      ["missing runtime_version", { runtimeVersion: undefined }],
      ["unparseable runtime_version", { runtimeVersion: "53-no-prefix" }],
      ["negative duration", { buildDurationMs: -1 }],
    ])("fails closed on %s", async (_label, overrides) => {
      const { workflow, store } = createWorkflow({ store: readyBuildStore() });

      await expect(
        workflow.acceptBuildComplete({
          completion: validCompletion(overrides),
          authorizationHeader: await validAuthHeader(),
          context: ctx,
        })
      ).rejects.toBeInstanceOf(ImageBuildInvalidCallbackError);
      expect(store.tryMarkImageBuildReady).not.toHaveBeenCalled();
    });

    it("marks ready and deletes replaced artifacts", async () => {
      const store = readyBuildStore();
      store.tryMarkImageBuildReady.mockResolvedValue({
        type: "marked_ready",
        supersededImages: [
          { imageBuildId: "old-1", image: { providerImageId: "im-old" } },
          { imageBuildId: "old-2", image: { providerImageId: "" } },
        ],
      });
      const adapter = createAdapter();
      const { workflow } = createWorkflow({ store, adapter });

      const result = await workflow.acceptBuildComplete({
        completion: validCompletion(),
        authorizationHeader: await validAuthHeader(),
        context: ctx,
      });

      expect(store.tryMarkImageBuildReady).toHaveBeenCalledWith(
        "imgb-env_1-1-abcd",
        "modal",
        "im-modal-1",
        [{ repoOwner: "acme", repoName: "web", baseSha: "abc123" }],
        "v53-list-native-runtime",
        12_500
      );
      expect(result.type).toBe("build_ready");
      if (result.type !== "build_ready") throw new Error("unreachable");
      await result.cleanup;
      // Artifact-bearing row: provider delete then row delete. Artifact-less
      // row: left for the reaper.
      expect(adapter.deleteImage).toHaveBeenCalledTimes(1);
      expect(adapter.deleteImage).toHaveBeenCalledWith(
        expect.objectContaining({ image: expect.objectContaining({ providerImageId: "im-old" }) })
      );
      expect(store.deleteSupersededImage).toHaveBeenCalledTimes(1);
      expect(store.deleteSupersededImage).toHaveBeenCalledWith("old-1");
    });

    it("reports a late build superseded by a newer ready image", async () => {
      const store = readyBuildStore();
      store.tryMarkImageBuildReady.mockResolvedValue({
        type: "superseded_by_newer_ready",
        supersededImage: { imageBuildId: "late-1", image: { providerImageId: "im-late" } },
      });
      const adapter = createAdapter();
      const { workflow } = createWorkflow({ store, adapter });

      const result = await workflow.acceptBuildComplete({
        completion: validCompletion(),
        authorizationHeader: await validAuthHeader(),
        context: ctx,
      });

      expect(result.type).toBe("build_superseded");
      if (result.type !== "build_superseded") throw new Error("unreachable");
      await result.cleanup;
      expect(adapter.deleteImage).toHaveBeenCalledTimes(1);
      expect(store.deleteSupersededImage).toHaveBeenCalledWith("late-1");
    });

    it("rejects completion the state machine no longer accepts, recording the artifact", async () => {
      const store = readyBuildStore();
      store.tryMarkImageBuildReady.mockResolvedValue({
        type: "not_accepting_completion",
      });
      const { workflow } = createWorkflow({ store });

      await expect(
        workflow.acceptBuildComplete({
          completion: validCompletion(),
          authorizationHeader: await validAuthHeader(),
          context: ctx,
        })
      ).rejects.toBeInstanceOf(ImageBuildCompletionNotAcceptedError);
      // Superseded mid-transition: the artifact must reach the reaper.
      expect(store.recordArtifactOnSupersededBuild).toHaveBeenCalledWith(
        "imgb-env_1-1-abcd",
        "modal",
        "im-modal-1"
      );
    });

    it("records the artifact of an out-of-band superseded build before rejecting", async () => {
      const store = createStore();
      store.getCallbackBuild.mockResolvedValue(null);
      store.getBuildRow.mockResolvedValue({
        id: "imgb-env_1-1-abcd",
        scope_kind: "environment",
        scope_id: "env_1",
        provider: "modal",
        status: "superseded",
      });
      const { workflow } = createWorkflow({ store });

      await expect(
        workflow.acceptBuildComplete({
          completion: validCompletion(),
          authorizationHeader: await validAuthHeader(),
          context: ctx,
        })
      ).rejects.toBeInstanceOf(ImageBuildCompletionNotAcceptedError);
      expect(store.recordArtifactOnSupersededBuild).toHaveBeenCalledWith(
        "imgb-env_1-1-abcd",
        "modal",
        "im-modal-1"
      );
    });

    it("never records late artifacts for unauthenticated callers", async () => {
      const store = createStore();
      store.getCallbackBuild.mockResolvedValue(null);
      store.getBuildRow.mockResolvedValue({
        id: "imgb-env_1-1-abcd",
        scope_kind: "environment",
        scope_id: "env_1",
        provider: "modal",
        status: "superseded",
      });
      const { workflow } = createWorkflow({ store });

      await expect(
        workflow.acceptBuildComplete({
          completion: validCompletion(),
          authorizationHeader: "Bearer forged",
          context: ctx,
        })
      ).rejects.toBeInstanceOf(ImageBuildCallbackAuthRejectedError);
      expect(store.recordArtifactOnSupersededBuild).not.toHaveBeenCalled();
    });
  });

  describe("acceptBuildFailed", () => {
    it("marks the build failed", async () => {
      const store = createStore();
      store.getCallbackBuild.mockResolvedValue({
        id: "imgb-env_1-1-abcd",
        scope: ENV_SCOPE,
        provider: "modal",
        providerSessionId: null,
        status: "building",
      });
      const { workflow } = createWorkflow({ store });

      const result = await workflow.acceptBuildFailed({
        failure: { buildId: "imgb-env_1-1-abcd", errorMessage: "setup.failed: boom" },
        authorizationHeader: await validAuthHeader(),
        context: ctx,
      });

      expect(result).toEqual({ type: "build_failed" });
      expect(store.markBuildFailed).toHaveBeenCalledWith(
        "imgb-env_1-1-abcd",
        "modal",
        "setup.failed: boom"
      );
    });

    it("rejects failures for unknown builds", async () => {
      const { workflow } = createWorkflow({});

      await expect(
        workflow.acceptBuildFailed({
          failure: { buildId: "nope", errorMessage: "boom" },
          authorizationHeader: await validAuthHeader(),
          context: ctx,
        })
      ).rejects.toBeInstanceOf(ImageBuildFailureNotAcceptedError);
    });
  });

  describe("provider_session builds (Vercel/OpenComputer)", () => {
    function sessionBuildStore() {
      const store = createStore();
      store.getCallbackBuild.mockResolvedValue({
        id: "imgb-env_1-1-abcd",
        scope: ENV_SCOPE,
        provider: "vercel",
        providerSessionId: "vercel-session-1",
        status: "building",
      });
      store.consumeCallbackToken.mockResolvedValue({
        id: "imgb-env_1-1-abcd",
        scope: ENV_SCOPE,
        provider: "vercel",
        providerSessionId: "vercel-session-1",
        status: "building",
      });
      store.verifyCallbackToken.mockResolvedValue(true);
      return store;
    }

    const bearerCallbackAuth = () =>
      vi.fn().mockResolvedValue({
        kind: "bearer_token",
        token: "callback-token",
        tokenHash: "hash-1",
        expiresAt: 9_999_999_999_999,
      });

    it("registers the callback token and binds the provider session on trigger", async () => {
      const planBuild = vi.fn().mockResolvedValue(vercelPlannedBuild());
      const adapter = createAdapter();
      adapter.startBuild.mockImplementation(async (_plan, callbacks) => {
        await callbacks.bindProviderSession("vercel-session-1");
      });
      const { workflow, store } = createWorkflow({
        planBuild,
        adapter,
        provider: "vercel",
        createCallbackAuth: bearerCallbackAuth(),
      });

      const result = await workflow.triggerBuild(ENV_SCOPE, ctx);

      expect(result.type).toBe("triggered");
      expect(store.registerBuild).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "vercel",
          callbackTokenHash: "hash-1",
          callbackTokenExpiresAt: 9_999_999_999_999,
        })
      );
      expect(store.bindProviderSession).toHaveBeenCalledWith(
        expect.stringMatching(/^imgb-env_1-/),
        "vercel",
        "vercel-session-1"
      );
    });

    it("tears down the build sandbox when the trigger fails after binding", async () => {
      const planBuild = vi.fn().mockResolvedValue(vercelPlannedBuild());
      const adapter = createAdapter();
      adapter.startBuild.mockImplementation(async (_plan, callbacks) => {
        await callbacks.bindProviderSession("vercel-session-1");
        throw new Error("launch failed");
      });
      const { workflow, store } = createWorkflow({
        planBuild,
        adapter,
        provider: "vercel",
        createCallbackAuth: bearerCallbackAuth(),
      });

      await expect(workflow.triggerBuild(ENV_SCOPE, ctx)).rejects.toBeInstanceOf(
        ImageBuildTriggerFailedError
      );
      expect(adapter.cleanupFailedBuild).toHaveBeenCalledWith(
        expect.objectContaining({
          providerSessionId: "vercel-session-1",
          errorMessage: "launch failed",
        })
      );
      expect(store.markBuildFailed).toHaveBeenCalled();
    });

    it("accepts completion with a valid callback token and finalizes deferred", async () => {
      const store = sessionBuildStore();
      store.tryMarkImageBuildReady.mockResolvedValue({
        type: "marked_ready",
        supersededImages: [],
      });
      const adapter = createAdapter();
      const { workflow } = createWorkflow({ store, adapter });

      const result = await workflow.acceptBuildComplete({
        completion: validCompletion({
          providerImageId: undefined,
          providerSessionId: "vercel-session-1",
        }),
        callbackToken: "callback-token",
        context: ctx,
      });

      expect(result.type).toBe("completion_accepted");
      if (result.type !== "completion_accepted") throw new Error("unreachable");
      await result.finalization;

      expect(store.consumeCallbackToken).toHaveBeenCalledWith(
        expect.objectContaining({
          buildId: "imgb-env_1-1-abcd",
          provider: "vercel",
          providerSessionId: "vercel-session-1",
        })
      );
      expect(store.verifyCallbackToken).toHaveBeenCalledWith(
        expect.objectContaining({
          buildId: "imgb-env_1-1-abcd",
          provider: "vercel",
          providerSessionId: "vercel-session-1",
        })
      );
      expect(adapter.finalizeSuccessfulBuild).toHaveBeenCalledWith(
        expect.objectContaining({ providerSessionId: "vercel-session-1" })
      );
      // The artifact id comes from finalization, never the callback.
      expect(store.tryMarkImageBuildReady).toHaveBeenCalledWith(
        "imgb-env_1-1-abcd",
        "vercel",
        "im-finalized",
        [{ repoOwner: "acme", repoName: "web", baseSha: "abc123" }],
        "v53-list-native-runtime",
        12_500
      );
      expect(adapter.cleanupCompletedBuild).toHaveBeenCalled();
    });

    it("rejects completion when the callback token does not consume", async () => {
      const store = sessionBuildStore();
      store.consumeCallbackToken.mockResolvedValue(null);
      const { workflow } = createWorkflow({ store });

      await expect(
        workflow.acceptBuildComplete({
          completion: validCompletion({
            providerImageId: undefined,
            providerSessionId: "vercel-session-1",
          }),
          callbackToken: "stale-token",
          context: ctx,
        })
      ).rejects.toBeInstanceOf(ImageBuildCallbackAuthRejectedError);
    });

    it("does not consume the token for an authenticated malformed completion", async () => {
      const store = sessionBuildStore();
      const { workflow } = createWorkflow({ store });

      await expect(
        workflow.acceptBuildComplete({
          completion: validCompletion({
            providerImageId: undefined,
            providerSessionId: "vercel-session-1",
            runtimeVersion: undefined,
          }),
          callbackToken: "callback-token",
          context: ctx,
        })
      ).rejects.toBeInstanceOf(ImageBuildInvalidCallbackError);

      expect(store.verifyCallbackToken).toHaveBeenCalled();
      expect(store.consumeCallbackToken).not.toHaveBeenCalled();
    });

    it("requires provider_session_id on provider-session completions", async () => {
      const { workflow } = createWorkflow({ store: sessionBuildStore() });

      await expect(
        workflow.acceptBuildComplete({
          completion: validCompletion({ providerImageId: undefined }),
          callbackToken: "callback-token",
          context: ctx,
        })
      ).rejects.toBeInstanceOf(ImageBuildInvalidCallbackError);
    });

    it("authenticates the token before validating the completion payload", async () => {
      const store = sessionBuildStore();
      store.verifyCallbackToken.mockResolvedValue(false);
      const { workflow } = createWorkflow({ store });

      // Malformed payload (no session id, no runtime version) + bad token:
      // the caller must see the auth failure, not a validation error.
      await expect(
        workflow.acceptBuildComplete({
          completion: validCompletion({
            providerImageId: undefined,
            runtimeVersion: undefined,
          }),
          callbackToken: "stale-token",
          context: ctx,
        })
      ).rejects.toBeInstanceOf(ImageBuildCallbackAuthRejectedError);
      expect(store.consumeCallbackToken).not.toHaveBeenCalled();
    });

    it("marks the build failed when deferred finalization fails", async () => {
      const store = sessionBuildStore();
      const adapter = createAdapter();
      adapter.finalizeSuccessfulBuild.mockRejectedValue(new Error("snapshot failed"));
      const { workflow } = createWorkflow({ store, adapter });

      const result = await workflow.acceptBuildComplete({
        completion: validCompletion({
          providerImageId: undefined,
          providerSessionId: "vercel-session-1",
        }),
        callbackToken: "callback-token",
        context: ctx,
      });
      if (result.type !== "completion_accepted") throw new Error("unreachable");
      await result.finalization;

      expect(store.markBuildFailed).toHaveBeenCalledWith(
        "imgb-env_1-1-abcd",
        "vercel",
        "snapshot failed"
      );
      expect(adapter.cleanupCompletedBuild).toHaveBeenCalled();
    });

    it("reclaims the finalized snapshot when the ready transition fails after it", async () => {
      // finalize succeeded (artifact exists provider-side) but the D1 ready
      // transition threw: nothing recorded the artifact id, so the deferred
      // path must delete it and fail the build — not leave the row building
      // with an orphaned snapshot.
      const store = sessionBuildStore();
      store.tryMarkImageBuildReady.mockRejectedValue(new Error("D1 unavailable"));
      const adapter = createAdapter();
      const { workflow } = createWorkflow({ store, adapter });

      const result = await workflow.acceptBuildComplete({
        completion: validCompletion({
          providerImageId: undefined,
          providerSessionId: "vercel-session-1",
        }),
        callbackToken: "callback-token",
        context: ctx,
      });
      if (result.type !== "completion_accepted") throw new Error("unreachable");
      await result.finalization;

      expect(adapter.deleteImage).toHaveBeenCalledWith(
        expect.objectContaining({
          image: expect.objectContaining({ providerImageId: "im-finalized" }),
        })
      );
      expect(store.markBuildFailed).toHaveBeenCalledWith(
        "imgb-env_1-1-abcd",
        "vercel",
        "D1 unavailable"
      );
      expect(adapter.cleanupCompletedBuild).toHaveBeenCalled();
    });

    it("marks provider-session failures through the callback token", async () => {
      const store = sessionBuildStore();
      store.markBuildFailedWithCallbackToken.mockResolvedValue(true);
      const adapter = createAdapter();
      const { workflow } = createWorkflow({ store, adapter });

      const result = await workflow.acceptBuildFailed({
        failure: {
          buildId: "imgb-env_1-1-abcd",
          providerSessionId: "vercel-session-1",
          errorMessage: "setup.failed: boom",
        },
        callbackToken: "callback-token",
        context: ctx,
      });

      expect(result.type).toBe("build_failed");
      if (result.type !== "build_failed") throw new Error("unreachable");
      await result.cleanup;
      expect(store.markBuildFailedWithCallbackToken).toHaveBeenCalledWith(
        expect.objectContaining({
          buildId: "imgb-env_1-1-abcd",
          provider: "vercel",
          providerSessionId: "vercel-session-1",
          error: "setup.failed: boom",
        })
      );
      expect(adapter.cleanupFailedBuild).toHaveBeenCalled();
    });

    it("rejects provider-session failures whose token does not consume", async () => {
      const store = sessionBuildStore();
      store.markBuildFailedWithCallbackToken.mockResolvedValue(false);
      const { workflow } = createWorkflow({ store });

      await expect(
        workflow.acceptBuildFailed({
          failure: {
            buildId: "imgb-env_1-1-abcd",
            providerSessionId: "vercel-session-1",
            errorMessage: "boom",
          },
          callbackToken: "stale-token",
          context: ctx,
        })
      ).rejects.toBeInstanceOf(ImageBuildCallbackAuthRejectedError);
    });

    it("authenticates the token before requiring provider_session_id on failures", async () => {
      const store = sessionBuildStore();
      store.markBuildFailedWithCallbackToken.mockResolvedValue(false);
      const { workflow } = createWorkflow({ store });

      await expect(
        workflow.acceptBuildFailed({
          failure: {
            buildId: "imgb-env_1-1-abcd",
            errorMessage: "boom",
          },
          callbackToken: "stale-token",
          context: ctx,
        })
      ).rejects.toBeInstanceOf(ImageBuildCallbackAuthRejectedError);
    });
  });

  describe("cleanupImages", () => {
    function reapableRow(id: string, providerImageId: string | null) {
      return {
        id,
        scope_kind: "environment" as const,
        scope_id: "env_1",
        provider: "modal" as const,
        provider_image_id: providerImageId,
        provider_session_id: null,
      };
    }

    it("deletes old failed rows and reaps superseded artifacts", async () => {
      const store = createStore();
      store.deleteOldFailedBuilds.mockResolvedValue(3);
      store.getSupersededImages.mockResolvedValue([
        reapableRow("s-artifact", "im-a"),
        reapableRow("s-bare", null),
        reapableRow("s-stuck", "im-stuck"),
      ]);
      const adapter = createAdapter();
      adapter.deleteImage.mockImplementation(async ({ image }) => {
        if (image.providerImageId === "im-stuck") throw new Error("provider 500");
      });
      const { workflow } = createWorkflow({ store, adapter });

      const result = await workflow.cleanupImages(86_400_000, ctx);

      // s-artifact: artifact deleted then row reaped. s-bare: no artifact, row
      // reaped directly. s-stuck: artifact delete failed, row kept for retry.
      expect(result).toEqual({ deletedFailed: 3, reapedFailed: 0, reapedSuperseded: 2 });
      expect(store.deleteSupersededImage).toHaveBeenCalledWith("s-artifact");
      expect(store.deleteSupersededImage).toHaveBeenCalledWith("s-bare");
      expect(store.deleteSupersededImage).not.toHaveBeenCalledWith("s-stuck");
    });

    it("reaps a restore-failed row's artifact then clears its columns, keeping it failed", async () => {
      const store = createStore();
      store.getFailedImagesWithArtifacts.mockResolvedValue([
        reapableRow("f-restore", "im-restore"),
      ]);
      const adapter = createAdapter();
      const { workflow } = createWorkflow({ store, adapter });

      const result = await workflow.cleanupImages(86_400_000, ctx);

      expect(result.reapedFailed).toBe(1);
      expect(adapter.deleteImage).toHaveBeenCalledWith(
        expect.objectContaining({
          image: { providerImageId: "im-restore", providerSessionId: null },
        })
      );
      // The failed row itself is kept for visibility — only the artifact
      // columns are nulled; it is never reaped as a superseded row.
      expect(store.clearFailedImageArtifact).toHaveBeenCalledWith("f-restore", "im-restore");
      expect(store.deleteSupersededImage).not.toHaveBeenCalledWith("f-restore");
    });

    it("keeps a failed row's artifact when the provider delete fails", async () => {
      const store = createStore();
      store.getFailedImagesWithArtifacts.mockResolvedValue([reapableRow("f-stuck", "im-stuck")]);
      const adapter = createAdapter();
      adapter.deleteImage.mockRejectedValue(new Error("provider 500"));
      const { workflow } = createWorkflow({ store, adapter });

      const result = await workflow.cleanupImages(86_400_000, ctx);

      // Artifact not lost: the columns are left intact so the next tick retries.
      expect(result.reapedFailed).toBe(0);
      expect(store.clearFailedImageArtifact).not.toHaveBeenCalled();
    });

    it("does not select already-reaped failed rows (idempotent across ticks)", async () => {
      const store = createStore();
      // getFailedImagesWithArtifacts only returns artifact-bearing rows, so a
      // previously-cleared failed row never reaches the adapter again.
      store.getFailedImagesWithArtifacts.mockResolvedValue([]);
      const adapter = createAdapter();
      const { workflow } = createWorkflow({ store, adapter });

      const result = await workflow.cleanupImages(86_400_000, ctx);

      expect(result.reapedFailed).toBe(0);
      expect(adapter.deleteImage).not.toHaveBeenCalled();
      expect(store.clearFailedImageArtifact).not.toHaveBeenCalled();
    });
  });
});
