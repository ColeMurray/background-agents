/**
 * Read-only MCP server over the Open-Inspect control plane.
 *
 * Runs locally over stdio and signs each request as the `mcp` service, which
 * asserts no actor. Read-only by construction: the client exposes GET only.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ControlPlaneClient, ControlPlaneError } from "./client";
import { TOOLS } from "./tools";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    // stderr, not stdout: stdout is the MCP transport and any stray byte
    // there corrupts the protocol stream.
    console.error(`open-inspect-mcp: ${name} is required`);
    process.exit(1);
  }
  return value;
}

export function createServer(client: ControlPlaneClient): McpServer {
  const server = new McpServer({ name: "open-inspect", version: "0.1.0" });

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await tool.run(client, args);
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          // Surface the failure to the model as tool output rather than
          // throwing: a 401 or a 404 is information it can act on.
          const detail =
            error instanceof ControlPlaneError
              ? error.message
              : error instanceof Error
                ? error.message
                : String(error);
          return { content: [{ type: "text" as const, text: detail }], isError: true };
        }
      }
    );
  }

  return server;
}

async function main(): Promise<void> {
  const client = new ControlPlaneClient({
    baseUrl: requireEnv("OPEN_INSPECT_CONTROL_PLANE_URL"),
    secret: requireEnv("OPEN_INSPECT_MCP_SECRET"),
  });
  await createServer(client).connect(new StdioServerTransport());
}

// Skipped under test, where the module is imported for createServer alone.
if (process.env.NODE_ENV !== "test") {
  main().catch((error: unknown) => {
    console.error("open-inspect-mcp: fatal:", error);
    process.exit(1);
  });
}
