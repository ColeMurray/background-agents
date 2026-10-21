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
    request: {
      /** A personal connection the owner granted to this session. */
      connectionId?: string;
      /** A shared server the deployment owns. */
      serverId?: string;
      toolName: string;
      arguments: Record<string, unknown>;
    },
    signal?: AbortSignal
  ): Promise<McpReadResult>;
  /** The session's authorized attachments, for the agent's own reference. */
  list(signal?: AbortSignal): Promise<{
    grants: Array<{ connectionId: string; serverName: string; toolNames: string[] }>;
    /** The deployment's shared servers this session may read. */
    shared: Array<{ serverId: string; serverName: string; toolNames: string[] }>;
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
          "Read from a reviewed MCP server this session may use: a shared server the deployment owns, or a personal connection its owner granted here. Only reviewed read tools are available, and a personal connection keeps its owner's identity.",
        { tag: false }
      ),
    ],
    tools: [
      defineTool({
        name: declaration.name,
        description:
          "Read from a reviewed MCP server. The connection must have been granted to this session by its owner.",
        parameters: Type.Object({
          /**
           * A personal connection the owner granted to this session.
           *
           * Exactly one target is named: a personal connection, or a shared
           * server the deployment owns.
           */
          connectionId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
          /** A shared server the deployment owns. */
          serverId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
          toolName: Type.String({ minLength: 1, maxLength: 256 }),
          arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        }),
        structuredOutputSchema: Type.Any(),
        replay: declaration.replay,
        callers: declaration.callers,
        execute: async (args, api, context) => {
          if (!args.connectionId && !args.serverId) {
            return {
              isError: true,
              output: [
                {
                  type: "text" as const,
                  text: "Name either a granted connection or a shared server",
                },
              ],
              details: {} as Record<string, JsonValue>,
            };
          }
          const result = await options.client.read(
            {
              ...(args.connectionId ? { connectionId: args.connectionId } : {}),
              ...(args.serverId ? { serverId: args.serverId } : {}),
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
              ...(result.connectionId ? { connectionId: result.connectionId } : {}),
              ...(result.serverId ? { serverId: result.serverId } : {}),
              toolName: result.toolName,
              truncated: result.truncated,
            },
          };
        },
      }),
    ],
  });
}
