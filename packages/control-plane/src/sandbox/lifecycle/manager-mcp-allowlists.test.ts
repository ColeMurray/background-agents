import { describe, expect, it, vi } from "vitest";
import { MIN_MCP_TOOL_ALLOWLIST_RUNTIME_GENERATION } from "../runtime-manifest";
import {
  createMockAlarmScheduler,
  createMockBroadcaster,
  createMockIdGenerator,
  createMockProvider,
  createMockSandbox,
  createMockSession,
  createMockStorage,
  createMockWebSocketManager,
  createTestConfig,
  createTestLifecycleManager,
  createUnmanagedShutdown,
  noLifetime,
} from "./test-helpers";

describe("MCP servers limited to selected tools", () => {
  const server = {
    type: "remote" as const,
    url: "https://mcp.example.com",
    repoScopes: null,
    enabled: true,
  };
  const mcpServerLookup = {
    getDecryptedForSession: vi.fn(async () => [
      { ...server, id: "mcp-1", name: "limited", toolAllowlist: ["search"] },
      { ...server, id: "mcp-2", name: "open", toolAllowlist: null },
    ]),
  };

  function launch(sandbox: ReturnType<typeof createMockSandbox>) {
    const storage = createMockStorage(createMockSession(), sandbox);
    const provider = createMockProvider({
      restoreFromSnapshot: vi.fn(async (config) => ({
        success: true as const,
        sandboxId: config.sandboxId,
        providerObjectId: "restored-source",
        lifetime: noLifetime(),
      })),
    });
    const recordWarning = vi.fn();
    const manager = createTestLifecycleManager(
      provider,
      storage,
      storage,
      createMockBroadcaster(),
      createMockWebSocketManager(false),
      createMockAlarmScheduler(),
      createMockIdGenerator(),
      createUnmanagedShutdown(),
      { ...createTestConfig(), mcpServerLookup, recordWarning }
    );
    return { manager, provider, recordWarning };
  }

  it("withholds them from a restore on an older runtime and tells the user", async () => {
    const { manager, provider, recordWarning } = launch(
      createMockSandbox({
        status: "stopped",
        snapshot_image_id: "saved-image",
        snapshot_runtime_version: `v${MIN_MCP_TOOL_ALLOWLIST_RUNTIME_GENERATION - 1}-old`,
      })
    );

    await manager.spawnSandbox();

    const restore = vi.mocked(provider.restoreFromSnapshot!).mock.calls[0][0];
    expect(restore.mcpServers?.map((s) => s.name)).toEqual(["open"]);
    expect(recordWarning).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("(limited)"),
      "mcp-servers-withheld:saved-image"
    );
  });

  it("keeps them for a restore on a runtime that enforces them", async () => {
    const { manager, provider, recordWarning } = launch(
      createMockSandbox({
        status: "stopped",
        snapshot_image_id: "saved-image",
        snapshot_runtime_version: `v${MIN_MCP_TOOL_ALLOWLIST_RUNTIME_GENERATION}-current`,
      })
    );

    await manager.spawnSandbox();

    const restore = vi.mocked(provider.restoreFromSnapshot!).mock.calls[0][0];
    expect(restore.mcpServers?.map((s) => s.name)).toEqual(["limited", "open"]);
    expect(recordWarning).not.toHaveBeenCalled();
  });

  it("keeps them for a fresh sandbox on the current runtime", async () => {
    const { manager, provider } = launch(createMockSandbox({ status: "pending" }));

    await manager.spawnSandbox();

    const create = vi.mocked(provider.createSandbox).mock.calls[0][0];
    expect(create.mcpServers?.map((s) => s.name)).toEqual(["limited", "open"]);
  });
});
