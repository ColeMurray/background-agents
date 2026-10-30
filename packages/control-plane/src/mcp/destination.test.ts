import { describe, expect, it } from "vitest";
import { mcpDestination } from "./destination";

describe("mcpDestination", () => {
  it("accepts a public HTTPS endpoint", () => {
    expect(mcpDestination("https://mcp.example.com/mcp").origin).toBe("https://mcp.example.com");
    expect(mcpDestination("https://MCP.example.com:443/mcp").origin).toBe(
      "https://mcp.example.com"
    );
  });

  it.each([
    "http://mcp.example.com/mcp",
    "https://203.0.113.7/mcp",
    "https://[2001:db8::1]/mcp",
    "https://localhost/mcp",
    "https://mcp.internal/mcp",
    "https://service.local/mcp",
    "https://intranet/mcp",
    "https://mcp.example.com./mcp",
    "https://user:secret@mcp.example.com/mcp",
    "https://mcp.example.com:8443/mcp",
    "https://mcp.example.com/mcp#fragment",
    "not a url",
  ])("rejects %s", (value) => {
    expect(() => mcpDestination(value)).toThrow(
      expect.objectContaining({ code: "mcp_unsupported" })
    );
  });

  it("requires the expected origin when one is given", () => {
    expect(() =>
      mcpDestination("https://tokens.example.net/token", "https://auth.example.com")
    ).toThrow(expect.objectContaining({ code: "mcp_unsupported" }));
    expect(
      mcpDestination("https://auth.example.com/token", "https://auth.example.com").pathname
    ).toBe("/token");
  });
});
