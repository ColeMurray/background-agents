import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageBuildStore } from "../db/image-builds";
import type { Env } from "../types";
import {
  ImageBuildCallbackAuthRejectedError,
  ImageBuildCompletionNotAcceptedError,
  ImageBuildFailureNotAcceptedError,
  ImageBuildScopeNotFoundError,
  ImageBuildTriggerFailedError,
  ImageBuildWorkflowUnavailableError,
} from "./errors";
import { DEFAULT_STALE_BUILD_MAX_AGE_MS } from "./maintenance";
import type { ImageBuildScope } from "./model";
import type { ImageBuildAdapterFactory } from "./provider-factory";
import type { ImageBuildFinalizationQueue } from "./finalization-job";
import type { ImageBuildPlan } from "./types";
import { COMPATIBLE_RUNTIME_VERSION } from "./test-helpers";
import { ImageBuildWorkflow } from "./workflow";

const ENV_SCOPE: ImageBuildScope = { kind: "environment", id: "env_1" };

// Every provider authenticates build callbacks with the single-use token
// minted at trigger time; the workflow hashes it under this pepper before
// the store lookup.
const MODAL_CALLBACK_TOKEN = "modal-callback-token";

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    WORKER_URL: "https://worker.test",
    IMAGE_CALLBACK_TOKEN_PEPPER: "test-callback-pepper",
    ...overrides,
  } as Env;
}

function createStore() {
  const acceptSuccessfulCompletion = vi.fn().mockResolvedValue("accepted");
  const acceptFailedCompletion = vi.fn().mockResolvedValue("accepted");
  const authorizeCompletionCallback = vi.fn().mockResolvedValue(null);
  return {
    registerBuild: vi.fn().mockResolvedValue(true),
    getActiveBuild: vi.fn().mockResolvedValue(null),
    markScopeStaleBuildFailed: vi.fn().mockResolvedValue(0),
    hasReadyImageForFingerprint: vi.fn().mockResolvedValue(false),
    bindProviderSession: vi.fn().mockResolvedValue(true),
    acceptSuccessfulCompletion,
    acceptFailedCompletion,
    authorizeCompletionCallback,
    finalization: {
      acceptSuccessfulCompletion,
      acceptFailedCompletion,
      authorizeCompletionCallback,
    },
    tryMarkImageBuildReady: vi.fn(),
    markBuildFailed: vi.fn().mockResolvedValue(true),
    supersedeActiveImages: vi.fn().mockResolvedValue(0),
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

function plannedBuild(overrides: Record<string, unknown> = {}): ImageBuildPlan {
  return {
    buildId: "imgb-env_1-1-abcd",
    scope: ENV_SCOPE,
    repositories: [{ repoOwner: "acme", repoName: "web", baseBranch: "main" }],
    repositoriesFingerprint: "fp-1",
    callbackUrl: "https://worker.test/image-builds/build-complete",
    failureCallbackUrl: "https://worker.test/image-builds/build-failed",
    buildTimeoutMs: 1800_000,
    correlation: { trace_id: "t", request_id: "r" },
    callbackToken: MODAL_CALLBACK_TOKEN,
    cloneAuth: { type: "unavailable" },
    ...overrides,
  };
}

function vercelPlannedBuild(): ImageBuildPlan {
  return {
    buildId: "imgb-env_1-1-abcd",
    scope: ENV_SCOPE,
    repositories: [{ repoOwner: "acme", repoName: "web", baseBranch: "main" }],
    repositoriesFingerprint: "fp-1",
    callbackUrl: "https://worker.test/image-builds/build-complete",
    failureCallbackUrl: "https://worker.test/image-builds/build-failed",
    buildTimeoutMs: 1800_000,
    correlation: { trace_id: "t", request_id: "r" },
    callbackToken: "callback-token",
    cloneAuth: { type: "unavailable" },
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
  queue?: ImageBuildFinalizationQueue;
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
    options.createCallbackAuth ??
    vi.fn().mockResolvedValue({
      token: MODAL_CALLBACK_TOKEN,
      tokenHash: "hash-modal",
      expiresAt: 9_999_999_999_999,
    });
  const provider = options.provider === undefined ? "modal" : options.provider;
  const planner = { planBuild, resolveTarget, createCallbackAuth } as unknown as NonNullable<
    ConstructorParameters<typeof ImageBuildWorkflow>[3]
  >["planner"];
  const workflow = new ImageBuildWorkflow(
    options.env ?? createEnv(),
    store as unknown as ImageBuildStore,
    factory,
    provider ? { provider, planner } : null,
    options.queue ?? { send: vi.fn().mockResolvedValue(undefined) }
  );
  return { workflow, store, adapter, factory, planBuild, resolveTarget, createCallbackAuth };
}

const ctx = { trace_id: "t", request_id: "r" };

function validCompletion(overrides: Record<string, unknown> = {}) {
  return {
    buildId: "imgb-env_1-1-abcd",
    providerSessionId: "vercel-session-1",
    repositoryShas: [{ repoOwner: "acme", repoName: "web", baseSha: "abc123" }],
    runtimeVersion: COMPATIBLE_RUNTIME_VERSION,
    buildDurationSeconds: 12.5,
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
        callbackTokenHash: "hash-modal",
        callbackTokenExpiresAt: 9_999_999_999_999,
      });
      expect(adapter.startBuild).toHaveBeenCalledTimes(1);
    });

    it("reuses a caller-resolved target for one reconciliation snapshot", async () => {
      const { workflow, resolveTarget, planBuild } = createWorkflow({});
      const target = {
        kind: "environment" as const,
        repositories: [{ repoOwner: "acme", repoName: "web", baseBranch: "main" }],
        repositoriesFingerprint: "fp-reconciled",
      };

      await workflow.triggerBuildWithTarget(ENV_SCOPE, target, ctx);

      expect(resolveTarget).not.toHaveBeenCalled();
      expect(planBuild).toHaveBeenCalledWith(expect.objectContaining({ target }));
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
            createCallbackAuth: vi
              .fn()
              .mockResolvedValue({ token: "t", tokenHash: "h", expiresAt: 9_999_999_999_999 }),
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

  describe("provider-session build callbacks", () => {
    function sessionBuildStore() {
      const store = createStore();
      store.authorizeCompletionCallback.mockResolvedValue({
        id: "imgb-env_1-1-abcd",
        scope: ENV_SCOPE,
        provider: "vercel",
        status: "building",
      });
      return store;
    }

    const bearerCallbackAuth = () =>
      vi.fn().mockResolvedValue({
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

    it("tears down the created sandbox when provider-session binding is rejected", async () => {
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
      store.bindProviderSession.mockResolvedValueOnce(false);

      await expect(workflow.triggerBuild(ENV_SCOPE, ctx)).rejects.toBeInstanceOf(
        ImageBuildTriggerFailedError
      );
      expect(adapter.cleanupFailedBuild).toHaveBeenCalledWith(
        expect.objectContaining({
          providerSessionId: "vercel-session-1",
          errorMessage: "Failed to bind vercel build session",
        })
      );
    });

    it("atomically accepts completion before publishing it", async () => {
      const store = sessionBuildStore();
      const queue = { send: vi.fn().mockResolvedValue(undefined) };
      const { workflow } = createWorkflow({ store, queue });

      await workflow.acceptBuildComplete({
        completion: validCompletion({
          providerSessionId: "vercel-session-1",
        }),
        callbackToken: "callback-token",
        context: ctx,
      });

      expect(queue.send).toHaveBeenCalledWith({
        version: 1,
        buildId: "imgb-env_1-1-abcd",
        completionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(store.acceptSuccessfulCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          buildId: "imgb-env_1-1-abcd",
          provider: "vercel",
          providerSessionId: "vercel-session-1",
          completionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        })
      );
      expect(store.authorizeCompletionCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          buildId: "imgb-env_1-1-abcd",
          providerSessionId: "vercel-session-1",
        })
      );
      expect(store.acceptSuccessfulCompletion.mock.invocationCallOrder[0]).toBeLessThan(
        queue.send.mock.invocationCallOrder[0]
      );
    });

    it("leaves an accepted completion recoverable when publishing fails", async () => {
      const store = sessionBuildStore();
      const queue = { send: vi.fn().mockRejectedValue(new Error("queue unavailable")) };
      const { workflow } = createWorkflow({ store, queue });

      await expect(
        workflow.acceptBuildComplete({
          completion: validCompletion({
            providerSessionId: "vercel-session-1",
          }),
          callbackToken: "callback-token",
          context: ctx,
        })
      ).rejects.toThrow("queue unavailable");

      expect(store.acceptSuccessfulCompletion).toHaveBeenCalledOnce();
      expect(store.acceptSuccessfulCompletion.mock.invocationCallOrder[0]).toBeLessThan(
        queue.send.mock.invocationCallOrder[0]
      );
    });

    it("rejects completion when the callback token does not consume", async () => {
      const store = sessionBuildStore();
      store.acceptSuccessfulCompletion.mockResolvedValue("rejected");
      const { workflow } = createWorkflow({ store });

      await expect(
        workflow.acceptBuildComplete({
          completion: validCompletion({
            providerSessionId: "vercel-session-1",
          }),
          callbackToken: "stale-token",
          context: ctx,
        })
      ).rejects.toBeInstanceOf(ImageBuildCompletionNotAcceptedError);
    });

    it("rejects completions whose callback token fails authentication", async () => {
      const store = sessionBuildStore();
      store.authorizeCompletionCallback.mockResolvedValue(null);
      const { workflow } = createWorkflow({ store });

      await expect(
        workflow.acceptBuildComplete({
          completion: validCompletion(),
          callbackToken: "stale-token",
          context: ctx,
        })
      ).rejects.toBeInstanceOf(ImageBuildCallbackAuthRejectedError);
    });

    it("atomically accepts failures before publishing them", async () => {
      const store = sessionBuildStore();
      const queue = { send: vi.fn().mockResolvedValue(undefined) };
      const { workflow } = createWorkflow({ store, queue });

      await workflow.acceptBuildFailed({
        failure: {
          buildId: "imgb-env_1-1-abcd",
          providerSessionId: "vercel-session-1",
          errorMessage: "setup.failed: boom",
        },
        callbackToken: "callback-token",
        context: ctx,
      });

      expect(queue.send).toHaveBeenCalledWith({
        version: 1,
        buildId: "imgb-env_1-1-abcd",
        completionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(store.acceptFailedCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          buildId: "imgb-env_1-1-abcd",
          provider: "vercel",
          providerSessionId: "vercel-session-1",
          errorMessage: "setup.failed: boom",
        })
      );
      expect(store.acceptFailedCompletion.mock.invocationCallOrder[0]).toBeLessThan(
        queue.send.mock.invocationCallOrder[0]
      );
    });

    it("republishes an exact accepted replay", async () => {
      const store = sessionBuildStore();
      store.authorizeCompletionCallback.mockResolvedValue({
        id: "imgb-env_1-1-abcd",
        scope: ENV_SCOPE,
        provider: "vercel",
        status: "building",
      });
      store.acceptSuccessfulCompletion.mockResolvedValue("replayed");
      const queue = { send: vi.fn().mockResolvedValue(undefined) };
      const { workflow } = createWorkflow({ store, queue });

      await expect(
        workflow.acceptBuildComplete({
          completion: validCompletion({
            providerSessionId: "vercel-session-1",
          }),
          callbackToken: "callback-token",
          context: ctx,
        })
      ).resolves.toBeUndefined();

      expect(queue.send).toHaveBeenCalledWith({
        version: 1,
        buildId: "imgb-env_1-1-abcd",
        completionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    });

    it("republishes an exact accepted failure replay", async () => {
      const store = sessionBuildStore();
      store.authorizeCompletionCallback.mockResolvedValue({
        id: "imgb-env_1-1-abcd",
        scope: ENV_SCOPE,
        provider: "vercel",
        status: "failed",
      });
      store.acceptFailedCompletion.mockResolvedValue("replayed");
      const queue = { send: vi.fn().mockResolvedValue(undefined) };
      const { workflow } = createWorkflow({ store, queue });

      await expect(
        workflow.acceptBuildFailed({
          failure: {
            buildId: "imgb-env_1-1-abcd",
            providerSessionId: "vercel-session-1",
            errorMessage: "setup.failed: boom",
          },
          callbackToken: "callback-token",
          context: ctx,
        })
      ).resolves.toBeUndefined();

      expect(queue.send).toHaveBeenCalledWith({
        version: 1,
        buildId: "imgb-env_1-1-abcd",
        completionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    });

    it("rejects provider-session failures whose token does not consume", async () => {
      const store = sessionBuildStore();
      store.acceptFailedCompletion.mockResolvedValue("rejected");
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
      ).rejects.toBeInstanceOf(ImageBuildFailureNotAcceptedError);
    });

    it("rejects failures whose callback token fails authentication", async () => {
      const store = sessionBuildStore();
      store.authorizeCompletionCallback.mockResolvedValue(null);
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
  });
});
