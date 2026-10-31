import { getHarnessCapabilities, type HarnessId } from "@open-inspect/shared/harnesses";
import {
  DEFAULT_MCP_AUTH_MODE,
  MANAGED_MCP_VERSION,
  type McpServerConfig,
  type RuntimeMcpServerConfig,
} from "@open-inspect/shared/types/integrations";
import { McpError } from "./errors";

/** The sandbox runtime generation that added per-turn personal connectors. */
const PERSONAL_MCP_RUNTIME_GENERATION = 80;

/** Why a launch keeps personal servers out of its sandbox. */
export type PersonalMcpWithheldCode = "mcp_harness_unsupported" | "mcp_runtime_outdated";

/**
 * Personal servers reach only a sandbox that can tear them down after each turn.
 * Any other sandbox would show the agent a server that every call refuses.
 */
export function personalMcpWithheldReason(
  harness: HarnessId,
  runtimeVersion: string
): PersonalMcpWithheldCode | null {
  if (!getHarnessCapabilities(harness).personalMcp) return "mcp_harness_unsupported";
  const generation = Number(/^v(\d+)/.exec(runtimeVersion)?.[1]);
  return generation >= PERSONAL_MCP_RUNTIME_GENERATION ? null : "mcp_runtime_outdated";
}

export function isPersonalMcpServer(server: RuntimeMcpServerConfig): boolean {
  return "managed_proxy" in server && server.managed_proxy.auth_mode === "user_oauth";
}

/** One provider-neutral launch/restore transformation. Registry input is never mutated. */
export function resolveRuntimeMcpServers(
  definitions: RuntimeMcpServerConfig[],
  launch: {
    controlPlaneUrl: string;
    sessionId: string;
    sandboxToken: string;
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
        managed || authMode === "user_oauth" || (entry as McpServerConfig).managedRouting;
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
