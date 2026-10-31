import { describe, expect, it, vi } from "vitest";
import type { HarnessId } from "@open-inspect/shared/harnesses";
import type { McpServerConfig } from "@open-inspect/shared/types/integrations";
import { COMPATIBLE_RUNTIME_VERSION } from "../../image-builds/test-helpers";
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
} from "./test-helpers";
describe("personal MCP servers at launch", () => {
  const personal: McpServerConfig = {
    id: "personal",
    name: "tracker",
    type: "remote",
    url: "https://mcp.example.com/mcp",
    enabled: true,
    authMode: "user_oauth",
    authRevision: 2,
  };
  const service: McpServerConfig = {
    id: "service",
    name: "docs",
    type: "remote",
    url: "https://docs.example.com/mcp",
    enabled: true,
    authMode: "service_credentials",
    headers: { Authorization: "Bearer service" },
  };

  async function launch(
    kind: "spawn" | "restore",
    harness: HarnessId,
    snapshotRuntimeVersion = COMPATIBLE_RUNTIME_VERSION
  ) {
    const session = createMockSession({ harness });
    const sandbox = createMockSandbox({
      status: kind === "spawn" ? "pending" : "stopped",
      snapshot_image_id: kind === "restore" ? "saved-image" : null,
      snapshot_runtime_version: kind === "restore" ? snapshotRuntimeVersion : null,
    });
    const storage = createMockStorage(session, sandbox);
    const provider = createMockProvider();
    const recordMcpServers = vi.fn();
    const manager = createTestLifecycleManager(
      provider,
      storage,
      storage,
      createMockBroadcaster(),
      createMockWebSocketManager(false),
      createMockAlarmScheduler(),
      createMockIdGenerator(),
      createUnmanagedShutdown(),
      {
        ...createTestConfig(),
        mcpServerLookup: { getForLaunch: async () => [personal, service] },
        recordMcpServers,
      }
    );

    await manager.spawnSandbox();

    const launched =
      kind === "spawn"
        ? vi.mocked(provider.createSandbox).mock.calls[0][0]
        : vi.mocked(provider.restoreFromSnapshot!).mock.calls[0][0];
    expect(recordMcpServers).toHaveBeenCalledOnce();
    const [recorded, withheld] = recordMcpServers.mock.calls[0];
    return {
      sent: launched.mcpServers?.map((server) => server.name),
      recorded: recorded.map((server: { name: string }) => server.name),
      withheld,
    };
  }

  it("keeps them out of a Codex sandbox and records why", async () => {
    await expect(launch("spawn", "codex")).resolves.toEqual({
      sent: ["docs"],
      recorded: ["tracker", "docs"],
      withheld: "mcp_harness_unsupported",
    });
  });

  it("keeps them out of a sandbox restored from an older runtime", async () => {
    await expect(launch("restore", "opencode", "v79-earlier")).resolves.toEqual({
      sent: ["docs"],
      recorded: ["tracker", "docs"],
      withheld: "mcp_runtime_outdated",
    });
  });

  it.each(["spawn", "restore"] as const)("sends them to a current OpenCode %s", async (kind) => {
    await expect(launch(kind, "opencode")).resolves.toEqual({
      sent: ["tracker", "docs"],
      recorded: ["tracker", "docs"],
      withheld: null,
    });
  });
});
