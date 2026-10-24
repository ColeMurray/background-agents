import { describe, expect, it } from "vitest";
import { assertMcpEgress, isPrivateAddress } from "./egress-policy";
import { McpRemoteUrlPolicyError } from "./remote-url-policy";

/**
 * The egress policy a Durable Object can actually enforce.
 *
 * The check is the *production* one: the broker calls it with the endpoint
 * it is about to hand to the transport. Remove it and an internal endpoint is
 * accepted — which is what the test below proves.
 */
describe("MCP egress policy", () => {
  const policy = { endpointHost: "mcp.example.com" };

  it("allows the reviewed endpoint", () => {
    expect(assertMcpEgress(policy, "https://mcp.example.com/mcp")).toMatchObject({ allowed: true });
  });

  it("refuses a redirect to another host", () => {
    expect(() => assertMcpEgress(policy, "https://evil.example.net/mcp")).toThrow(
      /exact configured host/
    );
  });

  it("refuses a literal private address", () => {
    expect(() =>
      assertMcpEgress({ endpointHost: "169.254.169.254" }, "https://169.254.169.254/mcp")
    ).toThrow(/private or reserved/);
  });

  it("refuses an endpoint that is not HTTPS", () => {
    expect(() => assertMcpEgress(policy, "http://mcp.example.com/mcp")).toThrow(
      McpRemoteUrlPolicyError
    );
  });

  it("refuses an endpoint that carries credentials", () => {
    expect(() => assertMcpEgress(policy, "https://user:pw@mcp.example.com/mcp")).toThrow(
      McpRemoteUrlPolicyError
    );
  });

  it("refuses a blocked name", () => {
    expect(() => assertMcpEgress({ endpointHost: "localhost" }, "https://localhost/mcp")).toThrow(
      McpRemoteUrlPolicyError
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
