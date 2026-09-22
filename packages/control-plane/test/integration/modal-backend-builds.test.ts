import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import { ImageBuildStore } from "../../src/db/image-builds";
import { ModalImageBuildAdapter } from "../../src/image-builds/modal-adapter";
import type { ImageBuildPlannerPort } from "../../src/image-builds/planner";
import { ImageBuildSessionCleanup } from "../../src/image-builds/session-cleanup";
import { ImageBuildWorkflow } from "../../src/image-builds/workflow";
import type { ModalClient } from "../../src/sandbox/client";
import { ModalSandboxProvider } from "../../src/sandbox/providers/modal-provider";
import { cleanD1Tables } from "./cleanup";
import { seedEnvironment, seedImageRowForScope } from "./image-build-helpers";

beforeEach(cleanD1Tables);

describe("Modal backend images over real D1", () => {
  it("partitions ready images and build admission by existing provider identity", async () => {
    const scope = { kind: "environment", id: await seedEnvironment() } as const;
    const store = new ImageBuildStore(env.DB);
    for (const provider of ["modal", "modal-vm"] as const) {
      await seedImageRowForScope(scope, {
        id: provider,
        provider,
        status: "ready",
        providerImageId: "im-" + provider,
      });
      expect(
        await store.registerBuild({
          id: "build-" + provider,
          scope,
          provider,
          repositoriesFingerprint: "fp",
          callbackTokenHash: "hash",
          callbackTokenExpiresAt: Date.now() + 60000,
        })
      ).toBe(true);
    }
    for (const provider of ["modal", "modal-vm"] as const) {
      expect(await store.getLatestReadyForSpawn(scope, provider)).toMatchObject({
        provider,
        provider_image_id: "im-" + provider,
      });
      expect(await store.getActiveBuild(scope, provider)).toMatchObject({
        id: "build-" + provider,
      });
    }
  });

  it("never starts an incompatible build and retries durable cleanup after reconstruction", async () => {
    const scope = { kind: "environment", id: await seedEnvironment() } as const;
    const client = {
      createImageBuildSandbox: vi
        .fn()
        .mockResolvedValue({ providerSessionId: "sb-legacy", sandboxBackend: undefined }),
      startImageBuildSandbox: vi.fn(),
      terminateImageBuildSandbox: vi.fn().mockRejectedValue(new Error("provider unreachable")),
      recoverImageBuildSandbox: vi.fn(),
    };
    const factory = {
      create: () =>
        new ModalImageBuildAdapter(
          new ModalSandboxProvider(client as unknown as ModalClient, "modal-vm")
        ),
    };
    const planner: ImageBuildPlannerPort = {
      resolveTarget: async () => ({
        kind: "environment",
        repositories: [{ repoOwner: "acme", repoName: "web", baseBranch: "main" }],
        repositoriesFingerprint: "fp",
      }),
      createCallbackAuth: async () => ({
        token: "token",
        tokenHash: "hash",
        expiresAt: Date.now() + 60000,
      }),
      planBuild: async (input) => ({
        ...input,
        repositories: input.target.repositories,
        repositoriesFingerprint: input.target.repositoriesFingerprint,
        buildTimeoutMs: 60000,
        callbackToken: "token",
        cloneAuth: { type: "unavailable" },
      }),
    };
    const correlation = { trace_id: "trace", request_id: "request" };
    const workflow = new ImageBuildWorkflow(
      createCloudflareEnv({ ...env, WORKER_URL: "https://worker.test" }),
      new ImageBuildStore(env.DB),
      factory,
      { provider: "modal-vm", planner }
    );
    await expect(workflow.triggerBuild(scope, correlation)).rejects.toThrow(
      "Failed to trigger build"
    );
    expect(client.startImageBuildSandbox).not.toHaveBeenCalled();
    const restartedStore = new ImageBuildStore(env.DB);
    const [pending] = await restartedStore.listSessionCleanup();
    expect(pending).toMatchObject({
      provider: "modal-vm",
      provider_session_id: "sb-legacy",
      provider_session_cleanup_pending: 1,
    });
    expect(await restartedStore.getLatestReadyForSpawn(scope, "modal-vm")).toBeNull();
    client.terminateImageBuildSandbox.mockResolvedValue(undefined);
    await expect(
      new ImageBuildSessionCleanup(restartedStore, factory).run(pending, correlation)
    ).resolves.toBe(true);
    expect(await restartedStore.listSessionCleanup()).toEqual([]);
  });
});
