import { describe, it, expect, vi } from "vitest";
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
import { WsClientMappingRepository } from "../../src/session/ws-client-mapping-repository";
import { componentsOf, runInSessionDO } from "./session-do-access";
import {
  closeWebSocket,
  initNamedSession,
  openClientWs,
  seedSandboxAuth,
  waitForSandboxStatus,
} from "./helpers";

/**
 * The composition root is fail-fast: both provider factories construct at
 * graph build, so a misconfigured deployment fails every session request at
 * initialization — before any session state is written — instead of running
 * degraded and surfacing the error at the first spawn or PR operation.
 */
describe("createSessionRuntime", () => {
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

  it.each([
    { raw: undefined, regular: "600000", expectedMs: 120_000, rejected: false },
    { raw: "60000", regular: "600000", expectedMs: 60_000, rejected: false },
    { raw: "59999", regular: "600000", expectedMs: 120_000, rejected: true },
    { raw: "not-a-number", regular: "600000", expectedMs: 120_000, rejected: true },
    { raw: "900000", regular: "600000", expectedMs: 600_000, rejected: false },
  ])(
    "wires unattended timeout $raw into scheduling",
    async ({ raw, regular, expectedMs, rejected }) => {
      const { stub } = await initNamedSession(`components-inactivity-${crypto.randomUUID()}`, {
        spawnSource: "automation",
      });
      await waitForSandboxStatus(stub, "failed");
      await runInSessionDO(stub, async (instance, state) => {
        // Isolate this arm from the earlier test spawn's persisted watchdog deadline.
        state.storage.sql.exec("DELETE FROM session_alarm_state");
        const platform = createDurableObjectSessionPlatform(state, env.DB);
        const setAlarm = vi.fn(async () => {});
        platform.alarmStore = {
          getAlarm: async () => null,
          setAlarm,
          deleteAlarm: async () => {},
        };
        const output = vi.spyOn(console, "warn").mockImplementation(() => {});
        const now = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(now);
        try {
          const runtime = createSessionRuntime(
            platform,
            createCloudflareEnv({
              ...(instance as unknown as { env: WorkerBindings }).env,
              SANDBOX_INACTIVITY_TIMEOUT_MS: regular,
              SANDBOX_UNATTENDED_INACTIVITY_TIMEOUT_MS: raw,
            } as WorkerBindings)
          );
          await runtime.internals.lifecycleManager.scheduleInactivityCheck();
          expect(setAlarm).toHaveBeenCalledExactlyOnceWith(now + expectedMs);
          const rejections = output.mock.calls
            .map(([line]) => JSON.parse(String(line)))
            .filter((entry) => entry.event === "config.invalid");
          expect(rejections).toEqual(
            rejected
              ? [
                  expect.objectContaining({
                    rejected_value: raw,
                    minimum_ms: 60_000,
                    timeout_ms: 120_000,
                  }),
                ]
              : []
          );
        } finally {
          output.mockRestore();
          clock.mockRestore();
        }
      });
    }
  );

  it("fails at graph build when the selected sandbox provider's credentials are missing", async () => {
    const error = await buildWithEnv({
      SANDBOX_PROVIDER: "modal",
      MODAL_API_SECRET: undefined,
      MODAL_WORKSPACE: undefined,
    });
    expect(error).toMatch(/MODAL_API_SECRET/);
  });

  it.each(["unsubscribed", "authorized", "expired", "lookup_failed"] as const)(
    "checks the %s client lease before extending an unattended sandbox after rehydration",
    async (lease) => {
      const name = `inactivity-client-${crypto.randomUUID()}`;
      const { stub } = await initNamedSession(name, { spawnSource: "automation" });
      await seedSandboxAuth(stub, { sandboxId: "idle-sandbox", authToken: "idle-token" });
      const { ws } = await openClientWs(name, { subscribe: lease !== "unsubscribed" });
      try {
        await runInSessionDO(stub, async (instance, state) => {
          const now = Date.now();
          state.storage.sql.exec(
            "UPDATE sandbox SET last_activity = ?, last_heartbeat = ?",
            now - 120_001,
            now
          );
          if (lease === "expired") {
            state.storage.sql.exec(
              "UPDATE ws_client_mapping SET authorization_expires_at = ?",
              now
            );
          }
          // Rebuild the graph so authorization must come from persisted leases, not cached clients.
          const runtime = createSessionRuntime(
            createDurableObjectSessionPlatform(state, env.DB),
            createCloudflareEnv((instance as unknown as { env: WorkerBindings }).env)
          );
          const shutdown = vi
            .spyOn(SandboxShutdownCoordinator.prototype, "requestShutdown")
            .mockResolvedValue("owned");
          const readMapping = WsClientMappingRepository.prototype.getWsClientMapping;
          const lookup = vi.spyOn(WsClientMappingRepository.prototype, "getWsClientMapping");
          if (lease === "lookup_failed") {
            lookup
              .mockImplementation(() => {
                throw new Error("lease read failed");
              })
              // The expiry sweep succeeds; the subsequent client-count lookup fails.
              .mockImplementationOnce(readMapping);
          }
          try {
            await runtime.server.onScheduledDeadline();
            if (lease === "authorized") {
              expect(shutdown).not.toHaveBeenCalled();
            } else {
              expect(shutdown).toHaveBeenCalledExactlyOnceWith("inactivity_timeout");
            }
          } finally {
            lookup.mockRestore();
            shutdown.mockRestore();
          }
        });
      } finally {
        await closeWebSocket(ws, { bestEffort: true });
      }
    }
  );

  it("announces the dashboard link of a Boat sandbox once its provider object is known", async () => {
    const stub = env.SESSION.get(env.SESSION.idFromName(`components-boat-${crypto.randomUUID()}`));
    await runInSessionDO(stub, (instance, state) => {
      componentsOf(instance);
      const runtime = createSessionRuntime(
        createDurableObjectSessionPlatform(state, env.DB),
        createCloudflareEnv({
          ...(instance as unknown as { env: WorkerBindings }).env,
          SANDBOX_PROVIDER: "boat",
          BOAT_API_KEY: "boat_test_key",
          BOAT_BASE_SNAPSHOT: "open-inspect",
        } as WorkerBindings)
      );
      const broadcast = vi.spyOn(SessionMessengerImpl.prototype, "broadcast");
      try {
        expect(runtime.internals.access.broadcastSandboxDashboardUrl("sbx_123")).toBe(true);
        expect(broadcast).toHaveBeenCalledWith({ type: "sandbox_access_changed" });
      } finally {
        vi.restoreAllMocks();
      }
    });
  });

  it("fails at graph build on an invalid SCM_PROVIDER", async () => {
    const error = await buildWithEnv({ SCM_PROVIDER: "not-a-real-provider" });
    expect(error).toMatch(/SCM_PROVIDER/i);
  });
});
