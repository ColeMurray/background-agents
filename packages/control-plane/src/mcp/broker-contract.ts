import { z } from "zod";

/**
 * The MCP broker's control-plane port.
 *
 * The port is deliberately small. It can open a connection, report its
 * status, read one reviewed tool, and tear the connection down. There is no
 * generic "call anything" entry point: a call must name a reviewed tool.
 */
export interface McpConnectionBrokerStatus {
  enabled: false;
  connectionId: string;
  ownerUserId: string;
  transportCacheEntries: number;
  reason: string;
}

/** One reviewed read-only tool call. */
export const mcpBrokerCallSchema = z
  .object({
    connectionId: z.string().min(1),
    ownerUserId: z.string().min(1),
    toolName: z.string().min(1).max(256),
    arguments: z.record(z.string(), z.json()).default({}),
  })
  .strict();

export type McpBrokerCall = z.infer<typeof mcpBrokerCallSchema>;

/**
 * The bounded result of one reviewed read.
 *
 * The content is deliberately untyped: it is the provider's own answer, and
 * the Durable Object RPC surface must not instantiate a recursive JSON type.
 * The SessionDO bounds and projects it before anything reaches the agent.
 */
export interface McpBrokerCallResult {
  content: unknown;
  truncated: boolean;
}

export interface McpConnectionBrokerDispatch {
  initialize(connectionId: string, ownerUserId: string): Promise<void>;
  status(connectionId: string): Promise<McpConnectionBrokerStatus>;
  /**
   * Read one reviewed tool.
   *
   * The broker revalidates the owner, the connection's status, and the
   * reviewed catalog before it reaches the provider, and it closes over the
   * credential so the credential never crosses back.
   */
  callTool(call: McpBrokerCall): Promise<McpBrokerCallResult>;
  destroy(connectionId: string, ownerUserId: string): Promise<void>;
}
