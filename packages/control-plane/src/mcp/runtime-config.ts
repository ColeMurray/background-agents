import {
  DEFAULT_MCP_AUTH_MODE,
  MANAGED_MCP_VERSION,
  type McpServerConfig,
  type RuntimeMcpServerConfig,
} from "@open-inspect/shared/types/integrations";
import { McpError } from "./errors";

/** One provider-neutral launch/restore transformation. Registry input is never mutated. */
export function resolveRuntimeMcpServers(
  definitions: RuntimeMcpServerConfig[],
  launch: {
    controlPlaneUrl: string;
    sessionId: string;
    sandboxToken: string;
    routingEnabled: boolean;
  }
): RuntimeMcpServerConfig[] {
  return definitions
    .filter((entry) => entry.enabled)
    .map((entry) => {
      if (entry.type === "local") return entry;
      const managed = "managed_proxy" in entry;
      const authMode = managed
        ? entry.managed_proxy.auth_mode
        : (entry.authMode ?? DEFAULT_MCP_AUTH_MODE);
      const shouldRoute =
        managed ||
        authMode === "user_oauth" ||
        (launch.routingEnabled && (entry as McpServerConfig).managedRouting);
      if (!shouldRoute) return entry;
      if (!entry.id || !launch.sandboxToken) throw new McpError("mcp_unsupported");
      const url = new URL(launch.controlPlaneUrl);
      url.pathname = `${url.pathname.replace(/\/$/, "")}/sessions/${encodeURIComponent(launch.sessionId)}/mcp/${encodeURIComponent(entry.id)}`;
      url.search = "";
      url.hash = "";
      return {
        id: entry.id,
        name: entry.name,
        type: "remote",
        url: url.toString(),
        enabled: true,
        headers: { Authorization: `Bearer ${launch.sandboxToken}` },
        managed_proxy: {
          version: MANAGED_MCP_VERSION,
          auth_mode: authMode,
          auth_revision: managed ? entry.managed_proxy.auth_revision : (entry.authRevision ?? 1),
        },
      };
    });
}
