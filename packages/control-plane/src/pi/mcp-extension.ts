import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { PI_MCP_TOOL_EFFECT_REGISTRATIONS } from "@open-inspect/shared";

interface SharedMcpReadResult {
  serverId: string;
  toolName: string;
  content: unknown;
  truncated: boolean;
}

export interface McpReadClient {
  /**
   * Ask the owning session to read one reviewed tool.
   *
   * The owning session owns the authority: it resolves the server's
   * repository scope and the reviewed catalog before anything reaches the
   * provider.
   */
  read(
    request: {
      /** The shared server the deployment owns. */
      serverId: string;
      toolName: string;
      arguments: Record<string, unknown>;
    },
    signal?: AbortSignal
  ): Promise<SharedMcpReadResult>;
  /** The shared servers this session may read, for the agent's own reference. */
  list(signal?: AbortSignal): Promise<{
    /** The deployment's shared servers this session may read. */
    shared: Array<{ serverId: string; serverName: string; toolNames: string[] }>;
  }>;
}

export interface McpExtensionOptions {
  client: McpReadClient;
}

const [SHARED_DECLARATION] = PI_MCP_TOOL_EFFECT_REGISTRATIONS;

/**
 * The agent's read-only MCP tool.
 *
 * The tool reaches a provider only through the owning session, and only for
 * a tool the deployment reviewed. It cannot mutate: an MCP mutation is not
 * a tool, it is an external action that a person approves.
 *
 * There is one tool because the shared server belongs to the deployment and
 * is scoped by the session's own repositories. It names exactly one target,
 * so the "exactly one target" rule holds at the tool boundary as well as at
 * the session's.
 */
export function createMcpExtension(options: McpExtensionOptions) {
  const readTool = (
    request: {
      serverId: string;
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
        serverId: result.serverId,
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
          "Read from a reviewed MCP server this session may use: a shared server the deployment owns. Only reviewed read tools are available.",
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
    ],
  });
}
