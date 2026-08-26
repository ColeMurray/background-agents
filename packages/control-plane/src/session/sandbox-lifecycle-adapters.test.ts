/**
 * Unit tests for the lifecycle-manager port adapters — the pieces with real
 * logic: the encrypt-before-store branch, the repository-shape defaults, the
 * setLastSpawnError rename, and the no-socket send branch. Pure forwards are
 * covered through the manager and server suites.
 */

import { describe, expect, it, vi } from "vitest";
import { decryptToken } from "../auth/crypto";
import { DurableObjectSandboxStorage, LifecycleSocketAdapter } from "./sandbox-lifecycle-adapters";
import type { SandboxRepository } from "./sandbox-repository";
import type { SessionCoreRepository } from "./session-core-repository";
import type { UserEnvResolver } from "./user-env-resolver";
import type { SessionWebSocketManager } from "./websocket-manager";

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";

function createStorage(overrides: { encryptionKey?: string } = {}) {
  const sandboxes = {
    updateSandboxCodeServer: vi.fn(),
    updateSandboxVnc: vi.fn(),
    updateSandboxTtyd: vi.fn(),
    updateSandboxSpawnError: vi.fn(),
  } as unknown as SandboxRepository;
  const sessions = {
    getSessionRepositories: vi.fn(() => [
      { repoOwner: "acme", repoName: "web-app", baseBranch: null, row: undefined },
      {
        repoOwner: "acme",
        repoName: "api",
        baseBranch: "develop",
        row: { base_sha: "abc123" },
      },
    ]),
  } as unknown as SessionCoreRepository;
  const userEnv = {} as UserEnvResolver;
  const storage = new DurableObjectSandboxStorage(
    sandboxes,
    sessions,
    userEnv,
    overrides.encryptionKey
  );
  return { storage, sandboxes, sessions };
}

describe("DurableObjectSandboxStorage", () => {
  it("encrypts secrets before storing when a key is configured", async () => {
    const { storage, sandboxes } = createStorage({ encryptionKey: ENCRYPTION_KEY });

    await storage.updateSandboxCodeServer("https://cs.example", "cs-secret");
    await storage.updateSandboxVnc("https://vnc.example", "vnc-secret");
    await storage.updateSandboxTtyd("https://ttyd.example", "ttyd-token");

    for (const [mock, url, plaintext] of [
      [vi.mocked(sandboxes.updateSandboxCodeServer), "https://cs.example", "cs-secret"],
      [vi.mocked(sandboxes.updateSandboxVnc), "https://vnc.example", "vnc-secret"],
      [vi.mocked(sandboxes.updateSandboxTtyd), "https://ttyd.example", "ttyd-token"],
    ] as const) {
      const [storedUrl, storedSecret] = mock.mock.calls[0];
      expect(storedUrl).toBe(url);
      expect(storedSecret).not.toBe(plaintext);
      await expect(decryptToken(storedSecret, ENCRYPTION_KEY)).resolves.toBe(plaintext);
    }
  });

  it("stores secrets as-is and synchronously when no key is configured", () => {
    const { storage, sandboxes } = createStorage();

    // No await before asserting: the keyless branch must persist before the
    // call returns, so a same-turn caller that does not await still observes
    // the write (and a later clear cannot be overwritten by a deferred store).
    const result = storage.updateSandboxCodeServer("https://cs.example", "cs-secret");

    expect(result).toBeUndefined();
    expect(sandboxes.updateSandboxCodeServer).toHaveBeenCalledWith(
      "https://cs.example",
      "cs-secret"
    );
  });

  it("maps repository entries with baseBranch and baseSha defaults", () => {
    const { storage } = createStorage();

    expect(storage.getSessionRepositories()).toEqual([
      { repoOwner: "acme", repoName: "web-app", baseBranch: "main", baseSha: null },
      { repoOwner: "acme", repoName: "api", baseBranch: "develop", baseSha: "abc123" },
    ]);
  });

  it("forwards setLastSpawnError to the spawn-error column update", () => {
    const { storage, sandboxes } = createStorage();

    storage.setLastSpawnError("boom", 1234);

    expect(sandboxes.updateSandboxSpawnError).toHaveBeenCalledWith("boom", 1234);
  });
});

describe("LifecycleSocketAdapter", () => {
  function createSockets(sandboxSocket: WebSocket | null) {
    return {
      getSandboxSocket: vi.fn(() => sandboxSocket),
      send: vi.fn(() => true),
      detachSandboxSocket: vi.fn(),
      getConnectedClientCount: vi.fn(() => 2),
    } as unknown as SessionWebSocketManager;
  }

  it("reports an unsent message when no sandbox socket is connected", () => {
    const sockets = createSockets(null);
    const adapter = new LifecycleSocketAdapter(sockets);

    expect(adapter.sendToSandbox({ type: "ping" })).toBe(false);
    expect(sockets.send).not.toHaveBeenCalled();
  });

  it("sends through the registered sandbox socket", () => {
    const sandboxSocket = { readyState: 1 } as unknown as WebSocket;
    const sockets = createSockets(sandboxSocket);
    const adapter = new LifecycleSocketAdapter(sockets);

    expect(adapter.sendToSandbox({ type: "ping" })).toBe(true);
    expect(sockets.send).toHaveBeenCalledWith(sandboxSocket, { type: "ping" });
  });
});
