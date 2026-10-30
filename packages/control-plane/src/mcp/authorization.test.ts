import { describe, expect, it } from "vitest";
import { createMcpDestinationPolicy } from "./authorization";

describe("createMcpDestinationPolicy", () => {
  it("matches allowlist entries by their normalized origin", () => {
    const allow = createMcpDestinationPolicy({
      MCP_ALLOWED_UPSTREAM_ORIGINS: " https://MCP.example.com/ ,not a url,http://plain.example.com",
    });

    expect(allow("https://mcp.example.com/mcp").origin).toBe("https://mcp.example.com");
    expect(() => allow("https://other.example.com/mcp")).toThrow(
      expect.objectContaining({ code: "mcp_unsupported" })
    );
  });

  it("allows nothing when the list is empty", () => {
    const allow = createMcpDestinationPolicy({ MCP_ALLOWED_UPSTREAM_ORIGINS: "" });

    expect(() => allow("https://mcp.example.com/mcp")).toThrow(
      expect.objectContaining({ code: "mcp_unsupported" })
    );
  });
});
