import useSWR from "swr";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import type {
  CreateMcpConnectionRequest,
  McpConnectionAuthorization,
  McpConnectionMetadata,
  McpConnectionsResponse,
} from "@open-inspect/shared/types/integrations";

const MCP_CONNECTIONS_KEY = "/api/mcp-connections";

export function useMcpConnections() {
  const { data: session } = useAuthSession();
  const { data, isLoading, mutate } = useSWR<McpConnectionsResponse>(
    session ? MCP_CONNECTIONS_KEY : null
  );
  return {
    enabled: data?.enabled ?? false,
    connections: data?.connections ?? [],
    loading: isLoading,
    mutate,
  };
}

export async function createMcpConnection(
  input: CreateMcpConnectionRequest
): Promise<McpConnectionMetadata> {
  const response = await browserApiFetch(MCP_CONNECTIONS_KEY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "Failed to stage dormant MCP connection");
  }
  return response.json();
}

export async function deleteMcpConnection(id: string): Promise<void> {
  const response = await browserApiFetch(`${MCP_CONNECTIONS_KEY}/${id}`, { method: "DELETE" });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "Failed to remove dormant MCP connection");
  }
}

/**
 * Ask the server to make one of the caller's own connections usable.
 *
 * The answer carries the server's own authorization URL when the server is
 * waiting for the owner's approval. It is a URL, not a credential, so the
 * browser may follow it.
 */
export async function authorizeMcpConnection(
  id: string,
  options?: { reconnect?: boolean }
): Promise<McpConnectionAuthorization> {
  const response = await browserApiFetch(`${MCP_CONNECTIONS_KEY}/${id}/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reconnect: options?.reconnect === true }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || "Failed to start the MCP authorization");
  }
  return response.json();
}
