import type { Env } from "../types";

export function mcpConnectionsEnabled(
  env: Pick<Env, "MCP_CONNECTIONS_ENABLED" | "MCP_CONNECTION">
): boolean {
  return env.MCP_CONNECTIONS_ENABLED?.trim().toLowerCase() === "true" && !!env.MCP_CONNECTION;
}
