import { describe, expect, it } from "vitest";
import {
  McpRemoteUrlPolicyError,
  assertExactMcpHost,
  validateMcpRemoteUrl,
} from "./remote-url-policy";

describe("MCP remote URL policy", () => {
  it("canonicalizes a public HTTPS endpoint and pins its exact host", () => {
    expect(validateMcpRemoteUrl("https://MCP.Example.COM:443/mcp")).toEqual({
      endpointUrl: "https://mcp.example.com/mcp",
      endpointHost: "mcp.example.com",
    });
  });

  it.each([
    "http://mcp.example.com/mcp",
    "https://user:pass@mcp.example.com/mcp",
    "https://mcp.example.com/mcp?token=secret",
    "https://mcp.example.com/mcp#fragment",
    "https://localhost/mcp",
    "https://localhost./mcp",
    "https://metadata.google.internal/mcp",
    "https://metadata.google.internal./mcp",
    "https://10.0.0.1/mcp",
    "https://172.31.2.3/mcp",
    "https://192.168.1.1/mcp",
    "https://100.64.0.1/mcp",
    "https://192.0.2.1/mcp",
    "https://198.18.0.1/mcp",
    "https://224.0.0.1/mcp",
    "https://255.255.255.255/mcp",
    "https://169.254.169.254/latest/meta-data",
    "https://127.0.0.1/mcp",
    "https://2130706433/mcp",
    "https://[::1]/mcp",
    "https://[::ffff:127.0.0.1]/mcp",
    "https://[::ffff:10.0.0.1]/mcp",
    "https://[fc00::1]/mcp",
    "https://[fe80::1]/mcp",
    "https://service.internal/mcp",
    "https://router.home.arpa/mcp",
  ])("rejects unsafe endpoint %s", (endpoint) => {
    expect(() => validateMcpRemoteUrl(endpoint)).toThrow(McpRemoteUrlPolicyError);
  });

  it("allows only the pinned host for subsequent MCP transport URLs", () => {
    expect(() =>
      assertExactMcpHost("https://mcp.example.com/another-path", "mcp.example.com")
    ).not.toThrow();
    expect(() => assertExactMcpHost("https://api.mcp.example.com/mcp", "mcp.example.com")).toThrow(
      /exact configured host/i
    );
    expect(() => assertExactMcpHost("https://example.com/mcp", "mcp.example.com")).toThrow(
      /exact configured host/i
    );
  });
});
