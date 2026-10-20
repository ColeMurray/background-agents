import { describe, expect, it } from "vitest";
import { assertMcpEgress, isPrivateAddress } from "./egress-policy";
import { McpRemoteUrlPolicyError } from "./remote-url-policy";

function policy(addresses: string[], allowedAddresses?: string[]) {
  return {
    endpointHost: "mcp.example.com",
    ...(allowedAddresses ? { allowedAddresses } : {}),
    resolve: async () => addresses,
  };
}

describe("MCP egress policy", () => {
  it("allows a reviewed host that resolves to a public address", async () => {
    await expect(
      assertMcpEgress(policy(["93.184.216.34"]), "https://mcp.example.com/mcp")
    ).resolves.toMatchObject({ allowed: true });
  });

  it("refuses a host that resolves to a private address", async () => {
    await expect(
      assertMcpEgress(policy(["10.0.0.5"]), "https://mcp.example.com/mcp")
    ).rejects.toThrow(McpRemoteUrlPolicyError);
  });

  it("refuses a host that resolves to a loopback address", async () => {
    await expect(
      assertMcpEgress(policy(["127.0.0.1"]), "https://mcp.example.com/mcp")
    ).rejects.toThrow(/private address/);
  });

  it("refuses a redirect to another host", async () => {
    await expect(
      assertMcpEgress(policy(["93.184.216.34"]), "https://evil.example.net/mcp")
    ).rejects.toThrow(/exact configured host/);
  });

  it("refuses a host that resolves to an unreviewed address", async () => {
    await expect(
      assertMcpEgress(policy(["93.184.216.34"], ["198.51.100.7"]), "https://mcp.example.com/mcp")
    ).rejects.toThrow(/unreviewed address/);
  });

  it("refuses a host that does not resolve at all", async () => {
    await expect(assertMcpEgress(policy([]), "https://mcp.example.com/mcp")).rejects.toThrow(
      /did not resolve/
    );
  });

  it("classifies the reserved address ranges", () => {
    expect(isPrivateAddress("10.1.2.3")).toBe(true);
    expect(isPrivateAddress("172.16.0.1")).toBe(true);
    expect(isPrivateAddress("172.32.0.1")).toBe(false);
    expect(isPrivateAddress("169.254.1.1")).toBe(true);
    expect(isPrivateAddress("192.168.1.1")).toBe(true);
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("2606:4700::1")).toBe(false);
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:93.184.216.34")).toBe(false);
  });
});
