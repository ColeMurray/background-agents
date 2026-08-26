/**
 * Unit tests for the lifecycle-manager port adapters. The storage class is
 * the repository itself plus three session-context reads, so the tests cover
 * the context logic (repository-shape defaults) and pin the inheritance
 * wiring; encryption behavior lives with the repository and is tested there.
 */

import { describe, expect, it, vi } from "vitest";
import { DurableObjectSandboxStorage, LifecycleSocketAdapter } from "./sandbox-lifecycle-adapters";
import type { SqlStorage } from "./sql-storage";
import type { Logger } from "../logger";
import type { SessionCoreRepository } from "./session-core-repository";
import type { UserEnvResolver } from "./user-env-resolver";
import type { SessionWebSocketManager } from "./websocket-manager";

function createStorage() {
  const execCalls: string[] = [];
  const sql = {
    exec: vi.fn((query: string) => {
      execCalls.push(query);
      return { toArray: () => [], one: () => null };
    }),
  } as unknown as SqlStorage;
  const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger;
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
  const storage = new DurableObjectSandboxStorage(
    sql,
    log,
    "0123456789abcdef0123456789abcdef",
    sessions,
    userEnv
  );
  return { storage, execCalls, userEnv };
}

describe("DurableObjectSandboxStorage", () => {
  it("maps repository entries with baseBranch and baseSha defaults", () => {
    const { storage } = createStorage();

    expect(storage.getSessionRepositories()).toEqual([
      { repoOwner: "acme", repoName: "web-app", baseBranch: "main", baseSha: null },
      { repoOwner: "acme", repoName: "api", baseBranch: "develop", baseSha: "abc123" },
    ]);
  });

  it("forwards user env resolution to the resolver", async () => {
    const { storage, userEnv } = createStorage();

    await expect(storage.getUserEnvVars()).resolves.toEqual({ FOO: "bar" });
    expect(userEnv.getUserEnvVars).toHaveBeenCalledOnce();
  });

  it("is the repository — sandbox writes hit SQL with no forwarding layer", () => {
    const { storage, execCalls } = createStorage();

    storage.updateSandboxStatus("ready");

    expect(execCalls[0]).toContain("UPDATE sandbox SET status");
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
