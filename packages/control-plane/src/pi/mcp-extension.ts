import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { PI_MCP_TOOL_EFFECT_REGISTRATIONS } from "@open-inspect/shared";
import type { McpReadResult } from "@open-inspect/shared/types/mcp-read";

export interface McpReadClient {
  /**
   * Ask the owning session to read one reviewed tool.
   *
   * The owning session owns the authority: it resolves the grant, the
   * reviewed catalog, and the owner's identity before anything reaches the
   * provider.
   */
  read(
    request: { connectionId: string; toolName: string; arguments: Record<string, unknown> },
    signal?: AbortSignal
  ): Promise<McpReadResult>;
  /** The session's authorized attachments, for the agent's own reference. */
  list(signal?: AbortSignal): Promise<{
    grants: Array<{ connectionId: string; serverName: string; toolNames: string[] }>;
  }>;
}

export interface McpExtensionOptions {
  client: McpReadClient;
}

/**
 * The agent's read-only MCP tool.
 *
 * The tool reaches a provider only through the owning session, and only for a
 * tool the owner reviewed and granted to this session. It cannot mutate: an
 * MCP mutation is not a tool, it is an external action that a person
 * approves.
 */
export function createMcpExtension(options: McpExtensionOptions) {
  const declaration = PI_MCP_TOOL_EFFECT_REGISTRATIONS[0];
  return defineExtension({
    name: "open-inspect.mcp",
    sections: [
      section(
        "mcp",
        () =>
          "Read from a reviewed MCP server this session was granted. Only reviewed read tools are available, and the connection owner keeps their identity.",
        { tag: false }
      ),
    ],
    tools: [
      defineTool({
        name: declaration.name,
        description:
          "Read from a reviewed MCP server. The connection must have been granted to this session by its owner.",
        parameters: Type.Object({
          connectionId: Type.String({ minLength: 1, maxLength: 256 }),
          toolName: Type.String({ minLength: 1, maxLength: 256 }),
          arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        }),
        structuredOutputSchema: Type.Any(),
        replay: declaration.replay,
        callers: declaration.callers,
        execute: async (args, api, context) => {
          const result = await options.client.read(
            {
              connectionId: args.connectionId,
              toolName: args.toolName,
              arguments: (args.arguments ?? {}) as Record<string, unknown>,
            },
            context.abortSignal
          );
          return {
            isError: false,
            output: [
              {
                type: "text" as const,
                text: JSON.stringify(result.content ?? null),
              },
            ],
            structuredOutput: result.content as JsonValue,
            details: {
              connectionId: result.connectionId,
              toolName: result.toolName,
              truncated: result.truncated,
            },
          };
        },
      }),
    ],
  });
}
