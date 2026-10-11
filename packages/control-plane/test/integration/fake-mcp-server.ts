interface McpMessage {
  id?: number;
  method: string;
  params?: { protocolVersion?: string };
}

/** The result the fake MCP server returns for a request, or undefined for a notification. */
function fakeMcpResult(message: McpMessage): unknown {
  if (message.method === "initialize") {
    return {
      protocolVersion: message.params?.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "integration-mcp", version: "1.0.0" },
    };
  }
  if (message.method === "tools/list") {
    return {
      tools: [
        { name: "search", description: "Search the docs", inputSchema: { type: "object" } },
        {
          name: "fetch_page",
          inputSchema: { type: "object" },
          outputSchema: { type: "object", properties: { text: { type: "string" } } },
        },
      ],
    };
  }
  return undefined;
}

/**
 * A Streamable HTTP MCP server for tool-discovery tests at mcp.integration.test.
 * Every path requires the bearer token and advertises the same tools, one with
 * an output schema; `/unauthorized` rejects every request and `/not-mcp`
 * answers with a web page.
 */
export async function fakeMcpServer(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/unauthorized") return new Response("Unauthorized", { status: 401 });
  if (request.headers.get("authorization") !== "Bearer integration-mcp-token") {
    return new Response("Unauthorized", { status: 401 });
  }
  if (url.pathname === "/not-mcp") {
    return new Response("<html>Docs</html>", { headers: { "content-type": "text/html" } });
  }

  if (request.method !== "POST") return new Response(null, { status: 405 });
  const message = (await request.json()) as McpMessage;
  const result = fakeMcpResult(message);
  if (result === undefined) return new Response(null, { status: 202 });
  return Response.json({ jsonrpc: "2.0", id: message.id, result });
}
