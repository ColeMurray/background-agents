import { describe, expect, it, vi } from "vitest";
import type {
  McpConnectionMetadata,
  McpServerMetadata,
} from "@open-inspect/shared/types/integrations";
import { evaluateMcpGrantScope } from "./mcp-grant-scope";

const connection: McpConnectionMetadata = {
  id: "connection-1",
  serverId: "server-1",
  serverRevision: 3,
  serverName: "Issues",
  endpointUrl: "https://mcp.example.com/rpc",
  endpointHost: "mcp.example.com",
  catalogSnapshotSha256: "a".repeat(64),
  status: "oauth_ready",
  tools: [],
  createdAt: 1,
  updatedAt: 1,
};

const server: McpServerMetadata = {
  id: "server-1",
  revision: 3,
  name: "Issues",
  type: "remote",
  url: "https://mcp.example.com/rpc",
  hasEnv: false,
  hasHeaders: false,
  enabled: true,
};

function options(current: McpServerMetadata) {
  return {
    db: {} as never,
    servers: { get: vi.fn(async () => current) },
    connections: { getOwned: vi.fn(async () => connection) },
    reviewedToolNames: vi.fn(async () => []),
  };
}

const request = {
  connectionId: "connection-1",
  ownerUserId: "user-1",
  repositories: [],
};

describe("evaluateMcpGrantScope", () => {
  it("allows the exact current reviewed endpoint", async () => {
    await expect(evaluateMcpGrantScope(options(server), request)).resolves.toEqual({
      kind: "allowed",
      serverId: "server-1",
      serverRevision: 3,
    });
  });

  it("revokes a connection after the server endpoint revision changes", async () => {
    await expect(
      evaluateMcpGrantScope(
        options({ ...server, revision: 4, url: "https://replacement.example.com/rpc" }),
        request
      )
    ).resolves.toEqual({
      kind: "denied",
      reason: "This MCP connection no longer matches its reviewed server",
    });
  });
});
