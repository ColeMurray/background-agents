/**
 * Unit tests for the lifecycle-manager port adapters: the session-context
 * facade's repository-shape defaults and the socket slice's send branches.
 * Sandbox storage needs no adapter — the repository satisfies that port
 * directly and is tested as itself.
 */

import { describe, expect, it, vi } from "vitest";
import { LifecycleSessionContext, LifecycleSocketAdapter } from "./sandbox-lifecycle-adapters";
import type { SessionCoreRepository } from "./session-core-repository";
import type { UserEnvResolver } from "./user-env-resolver";
import type { SessionWebSocketManager } from "./websocket-manager";

describe("LifecycleSessionContext", () => {
  function createContext() {
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
    const userEnv = {
      getUserEnvVars: vi.fn(async () => ({ FOO: "bar" })),
    } as unknown as UserEnvResolver;
    return { context: new LifecycleSessionContext(sessions, userEnv), userEnv };
  }

  it("maps repository entries with baseBranch and baseSha defaults", () => {
    const { context } = createContext();

    expect(context.getSessionRepositories()).toEqual([
      { repoOwner: "acme", repoName: "web-app", baseBranch: "main", baseSha: null },
      { repoOwner: "acme", repoName: "api", baseBranch: "develop", baseSha: "abc123" },
    ]);
  });

  it("forwards user env resolution to the resolver", async () => {
    const { context, userEnv } = createContext();

    await expect(context.getUserEnvVars()).resolves.toEqual({ FOO: "bar" });
    expect(userEnv.getUserEnvVars).toHaveBeenCalledOnce();
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
