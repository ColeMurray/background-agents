/**
 * MCP server over the Open-Inspect control plane.
 *
 * Runs locally over stdio and authenticates with a personal access token, so every request is
 * attributable to the user who issued it and bounded by the permissions the token was granted.
 * The control plane enforces that bound; this server only presents the tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { ControlPlaneClient, ControlPlaneError } from "./client";
import { TOOLS } from "./tools";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    // stderr, not stdout: stdout is the MCP transport and any stray byte there corrupts it.
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
        description: `${tool.description} Requires a token granted ${tool.requires}.`,
        // The SDK types its schemas with the workspace's hoisted zod, which a test dependency pins
        // below the zod these schemas and shared's are built with. Both are zod 4, converted and
        // validated through the schema objects' own methods, so only the declared types differ;
        // tools.test.ts lists and calls every tool over a real transport to keep that true.
        inputSchema: tool.inputSchema as unknown as ZodRawShapeCompat,
        annotations: {
          readOnlyHint: tool.readOnly,
          // A client uses this to decide how hard to prompt, so a write that replaces what later
          // readers act on has to declare itself even when it is recoverable.
          destructiveHint: tool.destructive ?? false,
          openWorldHint: true,
        },
      },
      async (args: Record<string, unknown>, extra) => {
        try {
          const result = await tool.run(client.withSignal(extra.signal), args);
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          // A refusal is information the model can act on, so it is tool output, not a throw.
          const detail =
            error instanceof ControlPlaneError || error instanceof Error
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
  let client: ControlPlaneClient;
  try {
    client = new ControlPlaneClient({
      baseUrl: requireEnv("OPEN_INSPECT_CONTROL_PLANE_URL"),
      token: requireEnv("OPEN_INSPECT_TOKEN"),
    });
  } catch (error) {
    console.error(`open-inspect-mcp: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  await createServer(client).connect(new StdioServerTransport());
}

// Imported for createServer alone by the tests, which set VITEST.
if (!process.env.VITEST) {
  main().catch((error: unknown) => {
    console.error("open-inspect-mcp: fatal:", error);
    process.exit(1);
  });
}
