import useSWR from "swr";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import type { McpServerConfig, McpServerMetadata } from "@open-inspect/shared";

const MCP_SERVERS_KEY = "/api/mcp-servers";

export function useMcpServers() {
  const { data: session } = useAuthSession();

  const { data, isLoading, mutate } = useSWR<McpServerMetadata[]>(session ? MCP_SERVERS_KEY : null);

  return {
    servers: data ?? [],
    loading: isLoading,
    mutate,
  };
}

export async function createMcpServer(
  config: Omit<McpServerConfig, "id">
): Promise<McpServerMetadata> {
  const response = await browserApiFetch(MCP_SERVERS_KEY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "Failed to create MCP server");
  }
  return response.json();
}

export async function updateMcpServer(
  id: string,
  patch: Partial<McpServerConfig>
): Promise<McpServerMetadata> {
  const response = await browserApiFetch(`${MCP_SERVERS_KEY}/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "Failed to update MCP server");
  }
  return response.json();
}

export async function deleteMcpServer(id: string): Promise<void> {
  const response = await browserApiFetch(`${MCP_SERVERS_KEY}/${id}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "Failed to delete MCP server");
  }
}
