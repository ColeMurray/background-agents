import { describe, it, expect } from "vitest";
import { resolveRuntimeMcpServers } from "./runtime-config";
import type { McpServerConfig } from "@open-inspect/shared/types/integrations";

const launch = {
  controlPlaneUrl: "https://control.example.com",
  sessionId: "session/name",
  sandboxToken: "allocation-a",
  routingEnabled: true,
};
describe("managed launch contract", () => {
  it("allowlists fields, preserves registry input, is idempotent, and replaces allocation auth", () => {
    const original: McpServerConfig = Object.freeze({
      id: "server/id",
      name: "gateway",
      type: "remote",
      url: "https://upstream.example.com/mcp",
      enabled: true,
      authMode: "user_oauth",
      authRevision: 3,
      headers: { Authorization: "upstream-secret" },
      env: { TOKEN: "fallback-secret" },
    });
    const result = resolveRuntimeMcpServers([original], launch);
    expect(result).toEqual([
      {
        id: "server/id",
        name: "gateway",
        type: "remote",
        url: "https://control.example.com/sessions/session%2Fname/mcp/server%2Fid",
        enabled: true,
        headers: { Authorization: "Bearer allocation-a" },
        managed_proxy: { version: 1, auth_mode: "user_oauth", auth_revision: 3 },
      },
    ]);
    expect(resolveRuntimeMcpServers(result, launch)).toEqual(result);
    expect(JSON.stringify(result)).not.toMatch(/upstream-secret|fallback-secret|upstream.example/);
    expect(
      resolveRuntimeMcpServers(result, { ...launch, sandboxToken: "allocation-b" })[0].headers
    ).toEqual({ Authorization: "Bearer allocation-b" });
    expect(original.headers?.Authorization).toBe("upstream-secret");
  });
  it("keeps legacy/local policy separate; routing rollback never converts user OAuth", () => {
    const local: McpServerConfig = {
      id: "local",
      name: "local",
      type: "local",
      enabled: true,
      command: ["tool"],
      env: { SECRET: "local-secret" },
    };
    const service: McpServerConfig = {
      id: "service",
      name: "service",
      type: "remote",
      enabled: true,
      url: "https://service.example.com",
      authMode: "service_credentials",
      headers: { Authorization: "service-secret" },
      managedRouting: true,
    };
    expect(
      resolveRuntimeMcpServers([local, service], { ...launch, routingEnabled: false })
    ).toEqual([local, service]);
    expect(
      resolveRuntimeMcpServers([{ ...service, authMode: "user_oauth" }], {
        ...launch,
        routingEnabled: false,
      })[0]
    ).toHaveProperty("managed_proxy.auth_mode", "user_oauth");
  });
});
