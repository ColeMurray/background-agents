export type McpErrorCode =
  | "mcp_connection_required"
  | "mcp_reconnect_required"
  | "mcp_disconnected"
  | "mcp_execution_inactive"
  | "mcp_runtime_restart_required"
  | "mcp_context_changed"
  | "mcp_unavailable"
  | "mcp_denied"
  | "mcp_unsupported"
  | "mcp_request_too_large";

export class McpError extends Error {
  constructor(
    readonly code: McpErrorCode,
    readonly status = 403
  ) {
    super(code);
  }
}

export function mcpErrorResponse(error: unknown): Response {
  const failure = error instanceof McpError ? error : new McpError("mcp_unavailable", 503);
  return Response.json(
    { error: failure.code, code: failure.code, connectionUrl: "/settings?tab=mcp-connections" },
    {
      status: failure.status,
      headers: { "Cache-Control": "no-store" },
    }
  );
}
