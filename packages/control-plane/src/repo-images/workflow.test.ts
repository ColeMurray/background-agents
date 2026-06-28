import { computeHmacHex } from "@open-inspect/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoImageStore } from "../db/repo-images";
import type { Env } from "../types";
import type { RepoImageBuildAdapterFactory } from "./provider-factory";
import type {
  AnyRepoImageBuildAdapter,
  RepoImageWorkflowContext,
  RepoImageWorkflowResult,
} from "./types";
import { RepoImageBuildWorkflow } from "./workflow";

const CALLBACK_TOKEN = "b".repeat(64);

function createContext(): RepoImageWorkflowContext {
  return {
    request_id: "request-1",
    trace_id: "trace-1",
  };
}

function createStore(overrides: Partial<RepoImageStore> = {}): RepoImageStore {
  return {
    consumeCallbackToken: vi.fn(async () => ({
      id: "build-1",
      provider: "vercel",
      provider_session_id: "provider-session-1",
    })),
    markBuildReady: vi.fn(async () => ({
      updated: true,
      replacedImageId: null,
      replacedProviderSessionId: null,
      replacedImages: [],
    })),
    markBuildFailed: vi.fn(async () => true),
    registerBuild: vi.fn(),
    bindProviderSession: vi.fn(),
    getLatestReady: vi.fn(),
    getLatestReadyForAnyProvider: vi.fn(),
    getStatus: vi.fn(),
    getAllStatus: vi.fn(),
    markStaleBuildsAsFailed: vi.fn(),
    deleteOldFailedBuilds: vi.fn(),
    deleteSupersededImage: vi.fn(async () => true),
    ...overrides,
  } as unknown as RepoImageStore;
}

function createAdapter(
  overrides: Partial<AnyRepoImageBuildAdapter> = {}
): AnyRepoImageBuildAdapter {
  return {
    startBuild: vi.fn(),
    finalizeSuccessfulBuild: vi.fn(async () => ({
      providerImageId: "provider-image-1",
      providerSessionId: "provider-session-1",
    })),
    cleanupFailedBuild: vi.fn(async () => undefined),
    deleteImage: vi.fn(),
    ...overrides,
  } as AnyRepoImageBuildAdapter;
}

function createAdapterFactory(adapter: AnyRepoImageBuildAdapter): RepoImageBuildAdapterFactory & {
  create: ReturnType<typeof vi.fn>;
} {
  return {
    create: vi.fn(() => adapter),
  } as unknown as RepoImageBuildAdapterFactory & {
    create: ReturnType<typeof vi.fn>;
  };
}

function createThrowingAdapterFactory(error: Error): RepoImageBuildAdapterFactory & {
  create: ReturnType<typeof vi.fn>;
} {
  return {
    create: vi.fn(() => {
      throw error;
    }),
  } as unknown as RepoImageBuildAdapterFactory & {
    create: ReturnType<typeof vi.fn>;
  };
}

async function tokenHash(): Promise<string> {
  return computeHmacHex(`repo-image-callback:${CALLBACK_TOKEN}`, "callback-secret");
}

function expectCompletionAccepted(result: RepoImageWorkflowResult): Promise<void> {
  expect(result).toMatchObject({ type: "completion_accepted" });
  if (result.type !== "completion_accepted") {
    throw new Error(`Expected completion_accepted, got ${result.type}`);
  }
  return result.finalization;
}

function expectBuildFailed(result: RepoImageWorkflowResult): Promise<void> | undefined {
  expect(result).toMatchObject({ type: "build_failed" });
  if (result.type !== "build_failed") {
    throw new Error(`Expected build_failed, got ${result.type}`);
  }
  return result.cleanup;
}

describe("RepoImageBuildWorkflow", () => {
  let env: Env;

  beforeEach(() => {
    env = {
      INTERNAL_CALLBACK_SECRET: "callback-secret",
    } as Env;
  });

  it("triggers a build from the planner-owned plan and binds provider sessions", async () => {
    const store = createStore({
      registerBuild: vi.fn(async () => undefined),
      bindProviderSession: vi.fn(async () => true),
    });
    const adapter = createAdapter({
      startBuild: vi.fn(async (_plan, callbacks) => {
        await callbacks.bindProviderSession("provider-session-1");
      }),
    });
    const planner = {
      planBuild: vi.fn(
        async (params: {
          buildId: string;
          repoOwner: string;
          repoName: string;
          now: number;
          callbackUrl: string;
          correlation: { request_id: string; trace_id: string };
        }) => ({
          type: "ok" as const,
          build: {
            plan: {
              provider: "vercel" as const,
              callbackMode: "provider_session" as const,
              buildId: params.buildId,
              repoOwner: "acme",
              repoName: "repo",
              baseBranch: "develop",
              callbackUrl: "https://worker.test/repo-images/build-complete",
              callbackToken: CALLBACK_TOKEN,
              cloneAuth: { type: "unavailable" as const },
              buildTimeoutMs: 1_800_000,
              correlation: { request_id: "request-1", trace_id: "trace-1" },
            },
            callbackAuth: {
              type: "bearer_token" as const,
              tokenHash: "token-hash",
              expiresAt: 456,
            },
          },
        })
      ),
    };
    const workflow = new RepoImageBuildWorkflow(
      { ...env, WORKER_URL: "https://worker.test" } as Env,
      store,
      createAdapterFactory(adapter),
      "vercel",
      planner
    );

    const result = await workflow.triggerBuild("acme", "repo", createContext());

    expect(result).toEqual({ type: "build_triggered", buildId: expect.stringContaining("img-") });
    expect(planner.planBuild).toHaveBeenCalledWith({
      buildId: expect.stringContaining("img-acme-repo-"),
      repoOwner: "acme",
      repoName: "repo",
      now: expect.any(Number),
      callbackUrl: "https://worker.test/repo-images/build-complete",
      correlation: { request_id: "request-1", trace_id: "trace-1" },
    });
    expect(store.registerBuild).toHaveBeenCalledWith({
      id: expect.stringContaining("img-acme-repo-"),
      repoOwner: "acme",
      repoName: "repo",
      provider: "vercel",
      baseBranch: "develop",
      callbackTokenHash: "token-hash",
      callbackTokenExpiresAt: 456,
    });
    expect(adapter.startBuild).toHaveBeenCalledWith(
      expect.objectContaining({ baseBranch: "develop", callbackUrl: expect.any(String) }),
      expect.objectContaining({ bindProviderSession: expect.any(Function) })
    );
    expect(store.bindProviderSession).toHaveBeenCalledWith(
      expect.stringContaining("img-acme-repo-"),
      "vercel",
      "provider-session-1"
    );
  });

  it("cleans up provider-session builds when trigger binding fails after provider start", async () => {
    const store = createStore({
      registerBuild: vi.fn(async () => undefined),
      bindProviderSession: vi.fn(async () => false),
    });
    const adapter = createAdapter({
      startBuild: vi.fn(async (_plan, callbacks) => {
        await callbacks.bindProviderSession("provider-session-1");
      }),
    });
    const planner = {
      planBuild: vi.fn(async (params: { buildId: string }) => ({
        type: "ok" as const,
        build: {
          plan: {
            provider: "vercel" as const,
            callbackMode: "provider_session" as const,
            buildId: params.buildId,
            repoOwner: "acme",
            repoName: "repo",
            baseBranch: "develop",
            callbackUrl: "https://worker.test/repo-images/build-complete",
            callbackToken: CALLBACK_TOKEN,
            cloneAuth: { type: "unavailable" as const },
            buildTimeoutMs: 1_800_000,
            correlation: { request_id: "request-1", trace_id: "trace-1" },
          },
          callbackAuth: {
            type: "bearer_token" as const,
            tokenHash: "token-hash",
            expiresAt: 456,
          },
        },
      })),
    };
    const workflow = new RepoImageBuildWorkflow(
      { ...env, WORKER_URL: "https://worker.test" } as Env,
      store,
      createAdapterFactory(adapter),
      "vercel",
      planner
    );

    const result = await workflow.triggerBuild("acme", "repo", createContext());

    expect(result).toEqual({
      type: "workflow_failed",
      operation: "trigger_build",
      message: "Failed to trigger build",
    });
    expect(adapter.cleanupFailedBuild).toHaveBeenCalledWith({
      kind: "provider_session",
      buildId: expect.stringContaining("img-acme-repo-"),
      providerSessionId: "provider-session-1",
      errorMessage: "Failed to bind vercel build session",
      correlation: { request_id: "request-1", trace_id: "trace-1" },
    });
  });

  it("maps a planner repo access miss without creating a build", async () => {
    const store = createStore();
    const adapter = createAdapter();
    const planner = {
      planBuild: vi.fn(async () => ({
        type: "repo_not_installed" as const,
        message: "Repository is not installed for the GitHub App",
      })),
    };
    const workflow = new RepoImageBuildWorkflow(
      { ...env, WORKER_URL: "https://worker.test" } as Env,
      store,
      createAdapterFactory(adapter),
      "modal",
      planner
    );

    const result = await workflow.triggerBuild("acme", "repo", createContext());

    expect(result).toEqual({
      type: "repository_not_installed",
      message: "Repository is not installed for the GitHub App",
    });
    expect(store.registerBuild).not.toHaveBeenCalled();
    expect(adapter.startBuild).not.toHaveBeenCalled();
  });

  it("marks Modal provider-image completions ready without callback-token auth", async () => {
    const store = createStore();
    const adapter = createAdapter({
      finalizeSuccessfulBuild: vi.fn(async (input) => {
        if (input.kind !== "provider_image") {
          throw new Error("expected provider image completion");
        }
        return { providerImageId: input.providerImageId };
      }),
    });
    const workflow = new RepoImageBuildWorkflow(env, store, createAdapterFactory(adapter), "modal");

    const result = await workflow.acceptBuildComplete({
      completion: {
        kind: "provider_image",
        buildId: "build-1",
        providerImageId: "modal-image-1",
        baseSha: "abc123",
        buildDurationMs: 4_500,
      },
      context: createContext(),
    });

    expect(result).toEqual({ type: "build_ready", replacedImages: [] });
    expect(store.consumeCallbackToken).not.toHaveBeenCalled();
    expect(adapter.finalizeSuccessfulBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "provider_image",
        buildId: "build-1",
        providerImageId: "modal-image-1",
        correlation: { request_id: "request-1", trace_id: "trace-1" },
      })
    );
    expect(store.markBuildReady).toHaveBeenCalledWith(
      "build-1",
      "modal",
      "modal-image-1",
      "abc123",
      4_500
    );
  });

  it("returns a cleanup task for superseded provider-image completions", async () => {
    const store = createStore({
      markBuildReady: vi.fn(async () => ({
        updated: true,
        replacedImageId: "old-modal-image",
        replacedProviderSessionId: null,
        replacedImages: [
          { repoImageId: "old-row-1", providerImageId: "old-modal-image", providerSessionId: null },
        ],
      })),
    });
    const adapter = createAdapter({
      finalizeSuccessfulBuild: vi.fn(async (input) => {
        if (input.kind !== "provider_image") {
          throw new Error("expected provider image completion");
        }
        return { providerImageId: input.providerImageId };
      }),
    });
    const workflow = new RepoImageBuildWorkflow(env, store, createAdapterFactory(adapter), "modal");

    const result = await workflow.acceptBuildComplete({
      completion: {
        kind: "provider_image",
        buildId: "build-1",
        providerImageId: "modal-image-1",
        baseSha: "abc123",
        buildDurationMs: 4_500,
      },
      context: createContext(),
    });

    expect(result).toMatchObject({
      type: "build_ready",
      replacedImages: [
        { repoImageId: "old-row-1", providerImageId: "old-modal-image", providerSessionId: null },
      ],
    });
    if (result.type !== "build_ready") {
      throw new Error(`Expected build_ready, got ${result.type}`);
    }

    await result.cleanup;
    expect(adapter.deleteImage).toHaveBeenCalledWith({
      providerImageId: "old-modal-image",
      providerSessionId: null,
      correlation: { request_id: "request-1", trace_id: "trace-1" },
    });
    expect(store.deleteSupersededImage).toHaveBeenCalledWith("old-row-1");
  });

  it("deletes a newly finalized provider image when Modal completion is rejected", async () => {
    const store = createStore({
      markBuildReady: vi.fn(async () => ({
        updated: false,
        replacedImageId: null,
        replacedProviderSessionId: null,
        replacedImages: [],
      })),
    });
    const adapter = createAdapter({
      finalizeSuccessfulBuild: vi.fn(async (input) => {
        if (input.kind !== "provider_image") {
          throw new Error("expected provider image completion");
        }
        return { providerImageId: input.providerImageId };
      }),
    });
    const workflow = new RepoImageBuildWorkflow(env, store, createAdapterFactory(adapter), "modal");

    const result = await workflow.acceptBuildComplete({
      completion: {
        kind: "provider_image",
        buildId: "build-1",
        providerImageId: "modal-image-1",
        baseSha: "abc123",
        buildDurationMs: 4_500,
      },
      context: createContext(),
    });

    expect(result).toEqual({
      type: "completion_not_accepted",
      message: "Build is not accepting completion",
    });
    expect(adapter.deleteImage).toHaveBeenCalledWith({
      providerImageId: "modal-image-1",
      providerSessionId: undefined,
      correlation: { request_id: "request-1", trace_id: "trace-1" },
    });
  });

  it("deletes a newly finalized provider image when the ready commit throws", async () => {
    const store = createStore({
      markBuildReady: vi.fn(async () => {
        throw new Error("D1 write failed");
      }),
    });
    const adapter = createAdapter({
      finalizeSuccessfulBuild: vi.fn(async (input) => {
        if (input.kind !== "provider_image") {
          throw new Error("expected provider image completion");
        }
        return { providerImageId: input.providerImageId };
      }),
    });
    const workflow = new RepoImageBuildWorkflow(env, store, createAdapterFactory(adapter), "modal");

    const result = await workflow.acceptBuildComplete({
      completion: {
        kind: "provider_image",
        buildId: "build-1",
        providerImageId: "modal-image-1",
        baseSha: "abc123",
        buildDurationMs: 4_500,
      },
      context: createContext(),
    });

    expect(result).toEqual({
      type: "workflow_failed",
      operation: "build_complete",
      message: "Failed to mark build as ready",
    });
    expect(adapter.deleteImage).toHaveBeenCalledWith({
      providerImageId: "modal-image-1",
      providerSessionId: undefined,
      correlation: { request_id: "request-1", trace_id: "trace-1" },
    });
  });

  it("finalizes a provider-session callback, commits ready, and deletes a superseded image", async () => {
    const store = createStore({
      markBuildReady: vi.fn(async () => ({
        updated: true,
        replacedImageId: "old-image-1",
        replacedProviderSessionId: "old-session-1",
        replacedImages: [
          {
            repoImageId: "old-row-1",
            providerImageId: "old-image-1",
            providerSessionId: "old-session-1",
          },
        ],
      })),
    });
    const adapter = createAdapter();
    const workflow = new RepoImageBuildWorkflow(
      env,
      store,
      createAdapterFactory(adapter),
      "vercel"
    );

    const result = await workflow.acceptBuildComplete({
      callbackToken: CALLBACK_TOKEN,
      completion: {
        kind: "provider_session",
        buildId: "build-1",
        providerSessionId: "provider-session-1",
        baseSha: "abc123",
        buildDurationMs: 12_500,
      },
      context: createContext(),
    });

    await expectCompletionAccepted(result);

    expect(store.consumeCallbackToken).toHaveBeenCalledWith({
      buildId: "build-1",
      provider: "vercel",
      providerSessionId: "provider-session-1",
      tokenHash: await tokenHash(),
      now: expect.any(Number),
    });
    expect(adapter.finalizeSuccessfulBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        buildId: "build-1",
        providerSessionId: "provider-session-1",
        baseSha: "abc123",
        buildDurationMs: 12_500,
      })
    );
    expect(store.markBuildReady).toHaveBeenCalledWith(
      "build-1",
      "vercel",
      "provider-image-1",
      "abc123",
      12_500
    );
    expect(adapter.deleteImage).toHaveBeenCalledWith({
      providerImageId: "old-image-1",
      providerSessionId: "old-session-1",
      correlation: { request_id: "request-1", trace_id: "trace-1" },
    });
    expect(store.deleteSupersededImage).toHaveBeenCalledWith("old-row-1");
  });

  it("does not fail a ready provider-session build when superseded row cleanup fails", async () => {
    const store = createStore({
      markBuildReady: vi.fn(async () => ({
        updated: true,
        replacedImageId: "old-image-1",
        replacedProviderSessionId: "old-session-1",
        replacedImages: [
          {
            repoImageId: "old-row-1",
            providerImageId: "old-image-1",
            providerSessionId: "old-session-1",
          },
        ],
      })),
      deleteSupersededImage: vi.fn(async () => {
        throw new Error("D1 delete failed");
      }),
    });
    const adapter = createAdapter();
    const workflow = new RepoImageBuildWorkflow(
      env,
      store,
      createAdapterFactory(adapter),
      "vercel"
    );

    const result = await workflow.acceptBuildComplete({
      callbackToken: CALLBACK_TOKEN,
      completion: {
        kind: "provider_session",
        buildId: "build-1",
        providerSessionId: "provider-session-1",
        baseSha: "abc123",
        buildDurationMs: 12_500,
      },
      context: createContext(),
    });

    await expectCompletionAccepted(result);

    expect(adapter.deleteImage).toHaveBeenCalledWith({
      providerImageId: "old-image-1",
      providerSessionId: "old-session-1",
      correlation: { request_id: "request-1", trace_id: "trace-1" },
    });
    expect(store.deleteSupersededImage).toHaveBeenCalledWith("old-row-1");
    expect(store.markBuildFailed).not.toHaveBeenCalled();
  });

  it("deletes a newly finalized orphan image when the build no longer accepts completion", async () => {
    const store = createStore({
      markBuildReady: vi.fn(async () => ({
        updated: false,
        replacedImageId: null,
        replacedProviderSessionId: null,
        replacedImages: [],
      })),
    });
    const adapter = createAdapter();
    const workflow = new RepoImageBuildWorkflow(
      env,
      store,
      createAdapterFactory(adapter),
      "vercel"
    );

    const result = await workflow.acceptBuildComplete({
      callbackToken: CALLBACK_TOKEN,
      completion: {
        kind: "provider_session",
        buildId: "build-1",
        providerSessionId: "provider-session-1",
        baseSha: "",
        buildDurationMs: 0,
      },
      context: createContext(),
    });

    await expectCompletionAccepted(result);

    expect(adapter.deleteImage).toHaveBeenCalledWith({
      providerImageId: "provider-image-1",
      providerSessionId: "provider-session-1",
      correlation: { request_id: "request-1", trace_id: "trace-1" },
    });
  });

  it("runs completed provider-session cleanup after rejected image cleanup", async () => {
    const store = createStore({
      markBuildReady: vi.fn(async () => ({
        updated: false,
        replacedImageId: null,
        replacedProviderSessionId: null,
        replacedImages: [],
      })),
    });
    const deleteImage = vi.fn(async () => undefined);
    const cleanupCompletedBuild = vi.fn(async () => undefined);
    const adapter = createAdapter({ deleteImage, cleanupCompletedBuild });
    const workflow = new RepoImageBuildWorkflow(
      env,
      store,
      createAdapterFactory(adapter),
      "opencomputer"
    );

    const result = await workflow.acceptBuildComplete({
      callbackToken: CALLBACK_TOKEN,
      completion: {
        kind: "provider_session",
        buildId: "build-1",
        providerSessionId: "provider-session-1",
        baseSha: "abc123",
        buildDurationMs: 12_500,
      },
      context: createContext(),
    });

    await expectCompletionAccepted(result);

    expect(deleteImage).toHaveBeenCalledWith({
      providerImageId: "provider-image-1",
      providerSessionId: "provider-session-1",
      correlation: { request_id: "request-1", trace_id: "trace-1" },
    });
    expect(cleanupCompletedBuild).toHaveBeenCalledWith({
      kind: "provider_session",
      buildId: "build-1",
      providerSessionId: "provider-session-1",
      correlation: { request_id: "request-1", trace_id: "trace-1" },
    });
    expect(deleteImage.mock.invocationCallOrder[0]).toBeLessThan(
      cleanupCompletedBuild.mock.invocationCallOrder[0]
    );
  });

  it("marks the build failed when provider finalization fails after token acceptance", async () => {
    const store = createStore();
    const adapter = createAdapter({
      finalizeSuccessfulBuild: vi.fn(async () => {
        throw new Error("snapshot failed");
      }),
    });
    const workflow = new RepoImageBuildWorkflow(
      env,
      store,
      createAdapterFactory(adapter),
      "vercel"
    );

    const result = await workflow.acceptBuildComplete({
      callbackToken: CALLBACK_TOKEN,
      completion: {
        kind: "provider_session",
        buildId: "build-1",
        providerSessionId: "provider-session-1",
        baseSha: "",
        buildDurationMs: 0,
      },
      context: createContext(),
    });

    await expectCompletionAccepted(result);

    expect(store.markBuildFailed).toHaveBeenCalledWith("build-1", "vercel", "snapshot failed");
  });

  it("rejects replayed or mismatched callback tokens without finalizing", async () => {
    const store = createStore({
      consumeCallbackToken: vi.fn(async () => null),
    });
    const adapter = createAdapter();
    const workflow = new RepoImageBuildWorkflow(
      env,
      store,
      createAdapterFactory(adapter),
      "vercel"
    );

    const result = await workflow.acceptBuildComplete({
      callbackToken: CALLBACK_TOKEN,
      completion: {
        kind: "provider_session",
        buildId: "build-1",
        providerSessionId: "provider-session-1",
        baseSha: "",
        buildDurationMs: 0,
      },
      context: createContext(),
    });

    expect(result).toEqual({ type: "callback_auth_rejected", message: "Unauthorized" });
    expect(adapter.finalizeSuccessfulBuild).not.toHaveBeenCalled();
  });

  it("rejects completion tokens before creating provider adapters", async () => {
    const store = createStore({
      consumeCallbackToken: vi.fn(async () => null),
    });
    const adapterFactory = createThrowingAdapterFactory(
      new Error("Vercel configuration not available")
    );
    const workflow = new RepoImageBuildWorkflow(env, store, adapterFactory, "vercel");

    const result = await workflow.acceptBuildComplete({
      callbackToken: CALLBACK_TOKEN,
      completion: {
        kind: "provider_session",
        buildId: "build-1",
        providerSessionId: "provider-session-1",
        baseSha: "",
        buildDurationMs: 0,
      },
      context: createContext(),
    });

    expect(result).toEqual({ type: "callback_auth_rejected", message: "Unauthorized" });
    expect(adapterFactory.create).not.toHaveBeenCalled();
  });

  it("marks valid completions failed when provider configuration is unavailable", async () => {
    const store = createStore();
    const adapterFactory = createThrowingAdapterFactory(
      new Error("Vercel configuration not available")
    );
    const workflow = new RepoImageBuildWorkflow(env, store, adapterFactory, "vercel");

    const result = await workflow.acceptBuildComplete({
      callbackToken: CALLBACK_TOKEN,
      completion: {
        kind: "provider_session",
        buildId: "build-1",
        providerSessionId: "provider-session-1",
        baseSha: "",
        buildDurationMs: 0,
      },
      context: createContext(),
    });

    await expectCompletionAccepted(result);

    expect(adapterFactory.create).toHaveBeenCalledWith("vercel");
    expect(store.markBuildFailed).toHaveBeenCalledWith(
      "build-1",
      "vercel",
      "Repo image provider is not configured"
    );
  });

  it("marks failed callbacks and asks the adapter to clean up provider-session sandboxes", async () => {
    const store = createStore();
    const adapter = createAdapter();
    const workflow = new RepoImageBuildWorkflow(
      env,
      store,
      createAdapterFactory(adapter),
      "vercel"
    );

    const result = await workflow.acceptBuildFailed({
      callbackToken: CALLBACK_TOKEN,
      failure: {
        kind: "provider_session",
        buildId: "build-1",
        providerSessionId: "provider-session-1",
        errorMessage: "setup failed",
      },
      context: createContext(),
    });

    await expectBuildFailed(result);

    expect(store.markBuildFailed).toHaveBeenCalledWith("build-1", "vercel", "setup failed");
    expect(adapter.cleanupFailedBuild).toHaveBeenCalledWith({
      buildId: "build-1",
      kind: "provider_session",
      providerSessionId: "provider-session-1",
      errorMessage: "setup failed",
      correlation: { request_id: "request-1", trace_id: "trace-1" },
    });
  });

  it("does not require provider cleanup configuration to accept failed callbacks", async () => {
    const store = createStore();
    const adapterFactory = createThrowingAdapterFactory(
      new Error("Vercel configuration not available")
    );
    const workflow = new RepoImageBuildWorkflow(env, store, adapterFactory, "vercel");

    const result = await workflow.acceptBuildFailed({
      callbackToken: CALLBACK_TOKEN,
      failure: {
        kind: "provider_session",
        buildId: "build-1",
        providerSessionId: "provider-session-1",
        errorMessage: "setup failed",
      },
      context: createContext(),
    });

    expect(result).toEqual({ type: "build_failed" });
    expect(store.markBuildFailed).toHaveBeenCalledWith("build-1", "vercel", "setup failed");
    expect(adapterFactory.create).toHaveBeenCalledWith("vercel");
  });
});
