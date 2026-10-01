import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { SessionDO } from "../../src/cloudflare/durable-object";
import { createCloudflareEnv, type WorkerBindings } from "../../src/cloudflare/platform";
import type { Env } from "../../src/types";
import { createSessionRuntime } from "../../src/session/components";
import { createDurableObjectSessionPlatform } from "../../src/cloudflare/session-platform";
import { SandboxLifecycleManager } from "../../src/sandbox/lifecycle/manager";
import { SandboxAccess } from "../../src/sandbox/lifecycle/sandbox-access";
import { SessionMessageQueue } from "../../src/session/message-queue";
import { SessionMessengerImpl } from "../../src/session/messenger";
import { SandboxShutdownCoordinator } from "../../src/session/sandbox-shutdown";
import { SessionStatusService } from "../../src/session/session-status-service";
import { SessionWebSocketManagerImpl } from "../../src/session/websocket-manager";
import { ModalSandboxProvider } from "../../src/sandbox/providers/modal-provider";
import { scmCloneIdentity } from "../../src/sandbox/sandbox-env";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, queryDO } from "./helpers";
import { componentsOf, runInSessionDO } from "./session-do-access";

/**
 * The composition root is fail-fast: both provider factories construct at
 * graph build, so a misconfigured deployment fails every session request at
 * initialization — before any session state is written — instead of running
 * degraded and surfacing the error at the first spawn or PR operation.
 */
describe("createSessionRuntime", () => {
  beforeEach(cleanD1Tables);
  afterEach(cleanD1Tables);
  async function buildWithEnv(overrides: Partial<Record<keyof Env, string | undefined>>) {
    const stub = env.SESSION.get(env.SESSION.idFromName(`components-eager-${crypto.randomUUID()}`));

    return runInSessionDO(stub, (instance: SessionDO, state) => {
      // Apply the schema first (idempotent init), matching production order.
      componentsOf(instance);

      const doctored = createCloudflareEnv({
        ...(instance as unknown as { env: WorkerBindings }).env,
        ...overrides,
      } as WorkerBindings);

      let error: string | null = null;
      try {
        createSessionRuntime(createDurableObjectSessionPlatform(state, env.DB), doctored);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      return error;
    });
  }

  it("builds the whole graph on a correctly configured deployment", async () => {
    expect(await buildWithEnv({})).toBeNull();
  });

  it.each([
    ["create", false],
    ["create", true],
    ["restore", false],
    ["restore", true],
  ] as const)(
    "preserves common GitLab identity on %s without minting (repo-less: %s)",
    async (source, repoLess) => {
      const { stub } = await initNamedSession(`restore-identity-${crypto.randomUUID()}`);
      await queryDO(stub, "DELETE FROM sandbox_preservation");
      await queryDO(
        stub,
        "UPDATE sandbox SET status = 'stopped', modal_object_id = NULL, snapshot_image_id = 'saved-image', snapshot_runtime_version = 'v62-compatible'"
      );
      if (source === "create") await queryDO(stub, "UPDATE sandbox SET snapshot_image_id = NULL");
      if (repoLess) {
        await queryDO(
          stub,
          "UPDATE session SET repo_owner = NULL, repo_name = NULL, repo_id = NULL, base_branch = NULL"
        );
        await queryDO(stub, "DELETE FROM session_repositories");
      }
      await runInSessionDO(stub, async (instance, state) => {
        const runtime = createSessionRuntime(
          createDurableObjectSessionPlatform(state, env.DB),
          createCloudflareEnv({
            ...(instance as unknown as { env: WorkerBindings }).env,
            SCM_PROVIDER: "gitlab",
            GITLAB_ACCESS_TOKEN: "configured-token",
          } as WorkerBindings)
        );
        const mint = vi
          .spyOn(runtime.internals.sourceControlProvider, "generateCredentialHelperAuth")
          .mockRejectedValue(new Error("mint unavailable"));
        const launch = vi
          .spyOn(ModalSandboxProvider.prototype, "restoreFromSnapshot")
          .mockResolvedValue({
            success: true,
            providerObjectId: "restored-source",
            lifetime: { kind: "none", observedAtMs: Date.now() },
          });
        const create = vi.spyOn(ModalSandboxProvider.prototype, "createSandbox").mockResolvedValue({
          sandboxId: "created-sandbox",
          createdAt: Date.now(),
          providerObjectId: "created-source",
          lifetime: { kind: "none", observedAtMs: Date.now() },
        });
        try {
          await runtime.internals.lifecycleManager.spawnSandbox();
          expect(source === "restore" ? launch : create).toHaveBeenCalledWith(
            expect.objectContaining({
              scmIdentity: scmCloneIdentity("gitlab"),
            })
          );
          expect(mint).not.toHaveBeenCalled();
        } finally {
          mint.mockRestore();
          launch.mockRestore();
          create.mockRestore();
        }
      });
    }
  );

  it("does not invoke runtime operations during construction", async () => {
    const stub = env.SESSION.get(env.SESSION.idFromName(`components-inert-${crypto.randomUUID()}`));
    await runInSessionDO(stub, (instance, state) => {
      componentsOf(instance);
      const platform = createDurableObjectSessionPlatform(state, env.DB);
      const runtimeOperation = vi.fn(() => {
        throw new Error("Runtime operation invoked during construction");
      });
      const autoResponse = vi.spyOn(platform.sockets, "setAutoResponse");
      platform.sockets.adopt = runtimeOperation;
      platform.sockets.tags = runtimeOperation;
      platform.sockets.sockets = runtimeOperation;
      platform.alarmStore = {
        getAlarm: runtimeOperation,
        setAlarm: runtimeOperation,
        deleteAlarm: runtimeOperation,
      };
      platform.createBackgroundTasks = () => ({ submit: runtimeOperation });
      const prototypes = [
        SandboxAccess.prototype,
        SandboxLifecycleManager.prototype,
        SandboxShutdownCoordinator.prototype,
        SessionMessageQueue.prototype,
        SessionMessengerImpl.prototype,
        SessionStatusService.prototype,
        SessionWebSocketManagerImpl.prototype,
      ];
      try {
        for (const prototype of prototypes) {
          for (const [name, descriptor] of Object.entries(
            Object.getOwnPropertyDescriptors(prototype)
          )) {
            if (name === "constructor" || typeof descriptor.value !== "function") continue;
            vi.spyOn(
              prototype as unknown as Record<string, () => unknown>,
              name
            ).mockImplementation(runtimeOperation);
          }
        }
        const runtime = createSessionRuntime(
          platform,
          createCloudflareEnv((instance as unknown as { env: WorkerBindings }).env)
        );
        expect(runtime.internals.lifecycleManager).toBeInstanceOf(SandboxLifecycleManager);
        expect(autoResponse).toHaveBeenCalledOnce();
        expect(runtimeOperation).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
      }
    });
  });

  it("fails at graph build on an unsupported SANDBOX_PROVIDER", async () => {
    const error = await buildWithEnv({ SANDBOX_PROVIDER: "not-a-real-sandbox-provider" });
    expect(error).toMatch(/SANDBOX_PROVIDER/);
  });

  it("fails at graph build when the selected sandbox provider's credentials are missing", async () => {
    const error = await buildWithEnv({
      SANDBOX_PROVIDER: "modal",
      MODAL_API_SECRET: undefined,
      MODAL_WORKSPACE: undefined,
    });
    expect(error).toMatch(/MODAL_API_SECRET/);
  });

  it("fails at graph build on an invalid SCM_PROVIDER", async () => {
    const error = await buildWithEnv({ SCM_PROVIDER: "not-a-real-provider" });
    expect(error).toMatch(/SCM_PROVIDER/i);
  });
});
