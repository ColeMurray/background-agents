import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateInternalToken } from "../auth/internal";
import type { EnvironmentImageStore } from "../db/environment-images";
import type { Env } from "../types";
import {
  EnvironmentImageCallbackAuthRejectedError,
  EnvironmentImageCompletionNotAcceptedError,
  EnvironmentImageEnvironmentNotFoundError,
  EnvironmentImageFailureNotAcceptedError,
  EnvironmentImageInvalidCallbackError,
  EnvironmentImageTriggerFailedError,
  EnvironmentImageWorkflowUnavailableError,
} from "./errors";
import type { EnvironmentImageBuildAdapterFactory } from "./provider-factory";
import type { PlannedEnvironmentImageBuild } from "./types";
import { EnvironmentImageBuildWorkflow } from "./workflow";

const INTERNAL_SECRET = "test-internal-secret";

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
    registerBuild: vi.fn().mockResolvedValue(undefined),
    getActiveBuild: vi.fn().mockResolvedValue(null),
    hasReadyImageForFingerprint: vi.fn().mockResolvedValue(false),
    getCallbackBuild: vi.fn().mockResolvedValue(null),
    tryMarkEnvironmentImageReady: vi.fn(),
    markBuildFailed: vi.fn().mockResolvedValue(true),
    deleteSupersededImage: vi.fn().mockResolvedValue(true),
    supersedeActiveImages: vi.fn().mockResolvedValue(0),
    getSupersededImages: vi.fn().mockResolvedValue([]),
    deleteOldFailedBuilds: vi.fn().mockResolvedValue(0),
    markStaleBuildsAsFailed: vi.fn().mockResolvedValue(0),
    getStatus: vi.fn().mockResolvedValue([]),
    getAllStatus: vi.fn().mockResolvedValue([]),
  };
}

function createAdapter() {
  return {
    startBuild: vi.fn().mockResolvedValue(undefined),
    deleteImage: vi.fn().mockResolvedValue(undefined),
  };
}

function plannedBuild(overrides: Record<string, unknown> = {}): PlannedEnvironmentImageBuild {
  return {
    plan: {
      buildId: "envimg-env_1-1-abcd",
      environmentId: "env_1",
      repositories: [{ repoOwner: "acme", repoName: "web", baseBranch: "main" }],
      membersFingerprint: "fp-1",
      callbackUrl: "https://worker.test/environment-images/build-complete",
      buildTimeoutMs: 1800_000,
      correlation: { trace_id: "t", request_id: "r" },
      provider: "modal",
      callbackMode: "provider_image",
      ...overrides,
    },
    callbackAuth: { type: "none" },
  };
}

function createWorkflow(options: {
  store?: ReturnType<typeof createStore>;
  adapter?: ReturnType<typeof createAdapter>;
  planBuild?: ReturnType<typeof vi.fn>;
  env?: Env;
  provider?: "modal" | null;
}) {
  const store = options.store ?? createStore();
  const adapter = options.adapter ?? createAdapter();
  const factory: EnvironmentImageBuildAdapterFactory = {
    create: vi.fn().mockReturnValue(adapter),
  };
  const planBuild = options.planBuild ?? vi.fn().mockResolvedValue(plannedBuild());
  const workflow = new EnvironmentImageBuildWorkflow(
    options.env ?? createEnv(),
    store as unknown as EnvironmentImageStore,
    factory,
    options.provider === undefined ? "modal" : options.provider,
    { planBuild } as unknown as ConstructorParameters<typeof EnvironmentImageBuildWorkflow>[4]
  );
  return { workflow, store, adapter, factory, planBuild };
}

const ctx = { trace_id: "t", request_id: "r" };

async function validAuthHeader(): Promise<string> {
  return `Bearer ${await generateInternalToken(INTERNAL_SECRET)}`;
}

function validCompletion(overrides: Record<string, unknown> = {}) {
  return {
    buildId: "envimg-env_1-1-abcd",
    providerImageId: "im-modal-1",
    memberShas: [{ repoOwner: "acme", repoName: "web", baseSha: "abc123" }],
    runtimeVersion: "v53-list-native-runtime",
    buildDurationMs: 12_500,
    ...overrides,
  };
}

describe("EnvironmentImageBuildWorkflow", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("triggerBuild", () => {
    it("plans, registers, and starts a build", async () => {
      const { workflow, store, adapter } = createWorkflow({});

      const result = await workflow.triggerBuild("env_1", ctx);

      expect(result.type).toBe("triggered");
      if (result.type !== "triggered") throw new Error("unreachable");
      expect(result.buildId).toMatch(/^envimg-env_1-\d+-/);
      expect(store.registerBuild).toHaveBeenCalledWith({
        id: result.buildId,
        environmentId: "env_1",
        provider: "modal",
        membersFingerprint: "fp-1",
      });
      expect(adapter.startBuild).toHaveBeenCalledTimes(1);
    });

    it("reports the in-flight build instead of stacking another", async () => {
      const store = createStore();
      store.getActiveBuild.mockResolvedValue({ id: "envimg-existing" });
      const { workflow, planBuild } = createWorkflow({ store });

      const result = await workflow.triggerBuild("env_1", ctx);

      expect(result).toEqual({ type: "already_building", buildId: "envimg-existing" });
      expect(planBuild).not.toHaveBeenCalled();
      expect(store.registerBuild).not.toHaveBeenCalled();
    });

    it("propagates environment-not-found from the planner", async () => {
      const planBuild = vi
        .fn()
        .mockRejectedValue(new EnvironmentImageEnvironmentNotFoundError("env_missing"));
      const { workflow, store } = createWorkflow({ planBuild });

      await expect(workflow.triggerBuild("env_missing", ctx)).rejects.toBeInstanceOf(
        EnvironmentImageEnvironmentNotFoundError
      );
      expect(store.registerBuild).not.toHaveBeenCalled();
    });

    it("marks the build failed when the adapter cannot start it", async () => {
      const adapter = createAdapter();
      adapter.startBuild.mockRejectedValue(new Error("modal down"));
      const { workflow, store } = createWorkflow({ adapter });

      await expect(workflow.triggerBuild("env_1", ctx)).rejects.toBeInstanceOf(
        EnvironmentImageTriggerFailedError
      );
      expect(store.markBuildFailed).toHaveBeenCalledWith(
        expect.stringMatching(/^envimg-env_1-/),
        "modal",
        "modal down"
      );
    });

    it("is unavailable without a provider", async () => {
      const { workflow } = createWorkflow({ provider: null });

      await expect(workflow.triggerBuild("env_1", ctx)).rejects.toBeInstanceOf(
        EnvironmentImageWorkflowUnavailableError
      );
    });

    it("is unavailable without WORKER_URL", async () => {
      const { workflow } = createWorkflow({ env: createEnv({ WORKER_URL: undefined }) });

      await expect(workflow.triggerBuild("env_1", ctx)).rejects.toBeInstanceOf(
        EnvironmentImageWorkflowUnavailableError
      );
    });
  });

  describe("triggerBuildIfStale", () => {
    it("skips when a ready image matches the current fingerprint", async () => {
      const store = createStore();
      store.hasReadyImageForFingerprint.mockResolvedValue(true);
      const { workflow } = createWorkflow({ store });

      const result = await workflow.triggerBuildIfStale("env_1", ctx);

      expect(result).toEqual({ type: "up_to_date" });
      expect(store.hasReadyImageForFingerprint).toHaveBeenCalledWith("env_1", "modal", "fp-1");
      expect(store.registerBuild).not.toHaveBeenCalled();
    });

    it("builds when no ready image matches", async () => {
      const { workflow, store } = createWorkflow({});

      const result = await workflow.triggerBuildIfStale("env_1", ctx);

      expect(result.type).toBe("triggered");
      expect(store.registerBuild).toHaveBeenCalledTimes(1);
    });
  });

  describe("acceptBuildComplete", () => {
    function readyBuildStore() {
      const store = createStore();
      store.getCallbackBuild.mockResolvedValue({
        id: "envimg-env_1-1-abcd",
        environmentId: "env_1",
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
      ).rejects.toBeInstanceOf(EnvironmentImageCompletionNotAcceptedError);
    });

    it("rejects bad internal auth", async () => {
      const { workflow } = createWorkflow({ store: readyBuildStore() });

      await expect(
        workflow.acceptBuildComplete({
          completion: validCompletion(),
          authorizationHeader: "Bearer forged",
          context: ctx,
        })
      ).rejects.toBeInstanceOf(EnvironmentImageCallbackAuthRejectedError);
    });

    it.each([
      ["missing provider_image_id", { providerImageId: undefined }],
      ["missing member_shas", { memberShas: undefined }],
      ["empty member_shas", { memberShas: [] }],
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
      ).rejects.toBeInstanceOf(EnvironmentImageInvalidCallbackError);
      expect(store.tryMarkEnvironmentImageReady).not.toHaveBeenCalled();
    });

    it("marks ready and deletes replaced artifacts", async () => {
      const store = readyBuildStore();
      store.tryMarkEnvironmentImageReady.mockResolvedValue({
        type: "marked_ready",
        supersededImages: [
          { environmentImageId: "old-1", image: { providerImageId: "im-old" } },
          { environmentImageId: "old-2", image: { providerImageId: "" } },
        ],
      });
      const adapter = createAdapter();
      const { workflow } = createWorkflow({ store, adapter });

      const result = await workflow.acceptBuildComplete({
        completion: validCompletion(),
        authorizationHeader: await validAuthHeader(),
        context: ctx,
      });

      expect(store.tryMarkEnvironmentImageReady).toHaveBeenCalledWith(
        "envimg-env_1-1-abcd",
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
      store.tryMarkEnvironmentImageReady.mockResolvedValue({
        type: "superseded_by_newer_ready",
        supersededImage: { environmentImageId: "late-1", image: { providerImageId: "im-late" } },
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

    it("rejects completion the state machine no longer accepts", async () => {
      const store = readyBuildStore();
      store.tryMarkEnvironmentImageReady.mockResolvedValue({
        type: "not_accepting_completion",
      });
      const { workflow } = createWorkflow({ store });

      await expect(
        workflow.acceptBuildComplete({
          completion: validCompletion(),
          authorizationHeader: await validAuthHeader(),
          context: ctx,
        })
      ).rejects.toBeInstanceOf(EnvironmentImageCompletionNotAcceptedError);
    });
  });

  describe("acceptBuildFailed", () => {
    it("marks the build failed", async () => {
      const store = createStore();
      store.getCallbackBuild.mockResolvedValue({
        id: "envimg-env_1-1-abcd",
        environmentId: "env_1",
        provider: "modal",
        providerSessionId: null,
        status: "building",
      });
      const { workflow } = createWorkflow({ store });

      const result = await workflow.acceptBuildFailed({
        failure: { buildId: "envimg-env_1-1-abcd", errorMessage: "setup.failed: boom" },
        authorizationHeader: await validAuthHeader(),
        context: ctx,
      });

      expect(result).toEqual({ type: "build_failed" });
      expect(store.markBuildFailed).toHaveBeenCalledWith(
        "envimg-env_1-1-abcd",
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
      ).rejects.toBeInstanceOf(EnvironmentImageFailureNotAcceptedError);
    });
  });

  describe("cleanupImages", () => {
    it("deletes old failed rows and reaps superseded artifacts", async () => {
      const store = createStore();
      store.deleteOldFailedBuilds.mockResolvedValue(3);
      store.getSupersededImages.mockResolvedValue([
        {
          id: "s-artifact",
          environment_id: "env_1",
          provider: "modal",
          provider_image_id: "im-a",
          provider_session_id: null,
        },
        {
          id: "s-bare",
          environment_id: "env_1",
          provider: "modal",
          provider_image_id: null,
          provider_session_id: null,
        },
        {
          id: "s-stuck",
          environment_id: "env_1",
          provider: "modal",
          provider_image_id: "im-stuck",
          provider_session_id: null,
        },
      ]);
      const adapter = createAdapter();
      adapter.deleteImage.mockImplementation(async ({ image }) => {
        if (image.providerImageId === "im-stuck") throw new Error("provider 500");
      });
      const { workflow } = createWorkflow({ store, adapter });

      const result = await workflow.cleanupImages(86_400_000, ctx);

      // s-artifact: artifact deleted then row reaped. s-bare: no artifact, row
      // reaped directly. s-stuck: artifact delete failed, row kept for retry.
      expect(result).toEqual({ deletedFailed: 3, reapedSuperseded: 2 });
      expect(store.deleteSupersededImage).toHaveBeenCalledWith("s-artifact");
      expect(store.deleteSupersededImage).toHaveBeenCalledWith("s-bare");
      expect(store.deleteSupersededImage).not.toHaveBeenCalledWith("s-stuck");
    });
  });
});
