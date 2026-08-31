import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  externalCreateSessionRequestSchema,
  externalEventFeedQuerySchema,
  externalFollowUpRequestSchema,
  externalSessionListQuerySchema,
} from "@open-inspect/shared/types/external-session-api";
import { classifyError, CliError } from "./errors.js";
import type { Operations } from "./operations.js";

const sessionId = z.string().min(1).describe("Repository-less Open Inspect session ID");
const MAX_WAIT_TIMEOUT_MS = 300_000;
export const MAX_MCP_RESULT_BYTES = 1024 * 1024;
const polling = {
  pollIntervalMs: z.number().int().min(100).max(30_000).optional(),
  timeoutMs: z.number().int().nonnegative().max(MAX_WAIT_TIMEOUT_MS).optional(),
};

/** Creates the narrow Increment 1 MCP surface over the shared operations layer. */
export function createMcpServer(operations: Operations): McpServer {
  const server = new McpServer({ name: "open-inspect", version: "0.1.0" });

  server.registerTool(
    "session_create",
    {
      description: "Create a repository-less text session",
      inputSchema: {
        ...externalCreateSessionRequestSchema.shape,
      },
    },
    async (input) =>
      runTool(() => operations.createSession(externalCreateSessionRequestSchema.parse(input)))
  );
  server.registerTool(
    "session_list",
    {
      description: "List repository-less sessions",
      inputSchema: { ...externalSessionListQuerySchema.shape },
    },
    async (query) =>
      runTool(() => operations.listSessions(externalSessionListQuerySchema.parse(query)))
  );
  server.registerTool(
    "session_get",
    {
      description: "Get a repository-less session",
      inputSchema: { sessionId },
    },
    async ({ sessionId }) => runTool(() => operations.getSession(sessionId))
  );
  server.registerTool(
    "session_prompt",
    {
      description: "Send a text follow-up prompt",
      inputSchema: {
        sessionId,
        ...externalFollowUpRequestSchema.shape,
      },
    },
    async ({ sessionId, ...input }) =>
      runTool(() => operations.promptSession(sessionId, externalFollowUpRequestSchema.parse(input)))
  );
  server.registerTool(
    "session_stop",
    {
      description: "Stop a session",
      inputSchema: { sessionId },
    },
    async ({ sessionId }) => runTool(() => operations.stopSession(sessionId))
  );
  server.registerTool(
    "session_events",
    {
      description: "Read one page of ordered session event changes",
      inputSchema: { sessionId, ...externalEventFeedQuerySchema.shape },
    },
    async ({ sessionId, ...query }) =>
      runTool(() => operations.events(sessionId, externalEventFeedQuerySchema.parse(query)))
  );
  server.registerTool(
    "session_wait",
    {
      description: "Poll until a session settles or the timeout expires",
      inputSchema: { sessionId, ...polling },
    },
    async ({ sessionId, ...options }) => runTool(() => operations.wait(sessionId, options))
  );

  return server;
}

/** Starts stdio transport without writing non-protocol data to stdout. */
export async function serveMcp(operations: Operations): Promise<void> {
  await createMcpServer(operations).connect(new StdioServerTransport());
}

export function toolResult(value: unknown) {
  const result = { content: [], structuredContent: asRecord(value) };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_MCP_RESULT_BYTES)
    throw new CliError("service", `MCP result exceeded ${MAX_MCP_RESULT_BYTES} bytes`);
  return result;
}

async function runTool(action: () => Promise<unknown>) {
  try {
    return toolResult(await action());
  } catch (cause) {
    const error = classifyError(cause);
    return {
      isError: true,
      content: [{ type: "text" as const, text: error.message }],
      structuredContent: {
        error: {
          kind: error.kind,
          message: error.message,
          ...(error.status ? { status: error.status } : {}),
        },
      },
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { result: value };
}
