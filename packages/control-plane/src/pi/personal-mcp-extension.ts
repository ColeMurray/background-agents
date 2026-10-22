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

const [SHARED_DECLARATION, CONNECTION_DECLARATION] = PI_MCP_TOOL_EFFECT_REGISTRATIONS;

/**
 * The agent's read-only MCP tools.
 *
 * The tools reach a provider only through the owning session, and only for a
 * tool the owner reviewed and granted to this session. It cannot mutate: an
 * MCP mutation is not a tool, it is an external action that a person
 * approves.
 *
 * There are two tools because the lanes are two credential domains. The
 * shared server belongs to the deployment and is scoped by the session's own
 * repositories; a personal connection carries one person's OAuth identity.
 * Each tool names exactly one target, so the "exactly one target" rule holds
 * at the tool boundary as well as at the session's.
 */
export function createMcpExtension(options: McpExtensionOptions) {
  const readTool = (
    request: {
      connectionId?: string;
      serverId?: string;
      toolName: string;
      arguments: Record<string, unknown>;
    },
    signal?: AbortSignal
  ) =>
    options.client.read(request, signal).then((result) => ({
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
    }));

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
        name: SHARED_DECLARATION.name,
        description:
          "Read from a reviewed MCP server the deployment owns. The session's own repositories decide which shared servers exist for it.",
        parameters: Type.Object({
          /** The shared server to read through. */
          serverId: Type.String({ minLength: 1, maxLength: 256 }),
          toolName: Type.String({ minLength: 1, maxLength: 256 }),
          arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        }),
        structuredOutputSchema: Type.Any(),
        replay: SHARED_DECLARATION.replay,
        callers: SHARED_DECLARATION.callers,
        execute: async (args, api, context) =>
          readTool(
            {
              serverId: args.serverId,
              toolName: args.toolName,
              arguments: (args.arguments ?? {}) as Record<string, unknown>,
            },
            context.abortSignal
          ),
      }),
      defineTool({
        name: CONNECTION_DECLARATION.name,
        description:
          "Read from a reviewed MCP connection its owner granted to this session. The read carries that owner's identity.",
        parameters: Type.Object({
          /** The personal connection to read through. */
          connectionId: Type.String({ minLength: 1, maxLength: 256 }),
          toolName: Type.String({ minLength: 1, maxLength: 256 }),
          arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        }),
        structuredOutputSchema: Type.Any(),
        replay: CONNECTION_DECLARATION.replay,
        callers: CONNECTION_DECLARATION.callers,
        execute: async (args, api, context) =>
          readTool(
            {
              connectionId: args.connectionId,
              toolName: args.toolName,
              arguments: (args.arguments ?? {}) as Record<string, unknown>,
            },
            context.abortSignal
          ),
      }),
    ],
  });
}
