import { describe, expect, it } from "vitest";
import { mcpConnectionsEnabled } from "./feature";

describe("MCP connection feature admission", () => {
  it("fails closed unless explicitly enabled", () => {
    const MCP_CONNECTION = {} as never;
    expect(mcpConnectionsEnabled({})).toBe(false);
    expect(mcpConnectionsEnabled({ MCP_CONNECTIONS_ENABLED: "true" })).toBe(false);
    expect(mcpConnectionsEnabled({ MCP_CONNECTIONS_ENABLED: "false", MCP_CONNECTION })).toBe(false);
    expect(mcpConnectionsEnabled({ MCP_CONNECTIONS_ENABLED: "unexpected", MCP_CONNECTION })).toBe(
      false
    );
    expect(mcpConnectionsEnabled({ MCP_CONNECTIONS_ENABLED: " TRUE ", MCP_CONNECTION })).toBe(true);
  });
});
