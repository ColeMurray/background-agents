import { describe, expect, it } from "vitest";
import { BoatSandboxProvider } from "../providers/boat-provider";
import { fastTimings, mockClient, providerConfig } from "../providers/boat-provider.test-helpers";
import {
  createMockAlarmScheduler,
  createMockBroadcaster,
  createMockIdGenerator,
  createMockSandbox,
  createMockSession,
  createMockStorage,
  createMockWebSocketManager,
  createTestConfig,
  createTestLifecycleManager,
  createUnmanagedShutdown,
} from "./test-helpers";

/**
 * A retained sandbox keeps the service passwords it was created with: its env
 * is fixed at create. The provider derives passwords from its API credential,
 * so once that credential rotates a resume derives different ones; what the
 * control plane publishes must stay the stored create-time values, which are
 * what code-server and VNC inside the sandbox still check.
 */
describe("persistent resume keeps the create-time service credentials", () => {
  it("publishes the stored code-server and VNC passwords after the provider credential rotates", async () => {
    const session = createMockSession({ code_server_enabled: 1, vnc_enabled: 1 });
    const sandbox = createMockSandbox({ status: "pending" });
    const storage = createMockStorage(session, sandbox);
    const broadcaster = createMockBroadcaster();
    const client = mockClient();
    const managerFor = (sandboxAccessPasswordSecret: string) =>
      createTestLifecycleManager(
        new BoatSandboxProvider(
          client,
          { ...providerConfig, sandboxAccessPasswordSecret },
          fastTimings
        ),
        storage,
        storage,
        broadcaster,
        createMockWebSocketManager(true),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );

    await managerFor("secret-before-rotation").spawnSandbox();

    expect(client.createSandbox).toHaveBeenCalledOnce();
    const createdCodeServerPassword = sandbox.code_server_password;
    const createdVncPassword = sandbox.vnc_password;
    expect(createdCodeServerPassword).toMatch(/^[a-f0-9]{32}$/);
    expect(createdVncPassword).toMatch(/^[A-Za-z0-9]{8}$/);

    // A stop keeps the credentials and clears the URLs; the credential the
    // provider derives from has rotated by the time the sandbox resumes.
    sandbox.status = "stopped";
    sandbox.code_server_url = null;
    sandbox.vnc_url = null;
    await managerFor("secret-after-rotation").spawnSandbox();

    // One create, then one resume (the mock sandbox is still live, so the
    // resume refreshes its deadline) that relaunches the runtime.
    expect(client.createSandbox).toHaveBeenCalledOnce();
    expect(client.startDetachedCommand).toHaveBeenCalledTimes(2);
    expect(storage.completeProviderResume).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        codeServer: { url: "https://sub-8080.on.boat.dev", password: createdCodeServerPassword },
        vnc: { url: "https://sub-6081.on.boat.dev", password: createdVncPassword },
      })
    );
    expect(sandbox.code_server_password).toBe(createdCodeServerPassword);
    expect(sandbox.vnc_password).toBe(createdVncPassword);
  });

  it("falls back to the provider's credentials when none were stored", async () => {
    const session = createMockSession({ code_server_enabled: 1 });
    const sandbox = createMockSandbox({ status: "pending" });
    const storage = createMockStorage(session, sandbox);
    const client = mockClient();
    const manager = createTestLifecycleManager(
      new BoatSandboxProvider(client, providerConfig, fastTimings),
      storage,
      storage,
      createMockBroadcaster(),
      createMockWebSocketManager(true),
      createMockAlarmScheduler(),
      createMockIdGenerator(),
      createUnmanagedShutdown(),
      createTestConfig()
    );

    await manager.spawnSandbox();
    sandbox.status = "stopped";
    sandbox.code_server_url = null;
    sandbox.code_server_password = null;
    await manager.spawnSandbox();

    expect(client.startDetachedCommand).toHaveBeenCalledTimes(2);
    expect(storage.completeProviderResume).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        codeServer: { url: "https://sub-8080.on.boat.dev", password: expect.any(String) },
      })
    );
    expect(sandbox.code_server_password).toMatch(/^[a-f0-9]{32}$/);
  });
});
