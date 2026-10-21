import { z } from "zod";
import type {
  McpConnectionAuthorization,
  McpConnectionTransportState,
} from "@open-inspect/shared/types/integrations";

/**
 * The MCP broker's control-plane port.
 *
 * The port is deliberately small. It can open a connection, report its
 * status, read one reviewed tool, and tear the connection down. There is no
 * generic "call anything" entry point: a call must name a reviewed tool.
 */
export interface McpConnectionBrokerStatus {
  /** Whether the connection can be read through right now. */
  enabled: boolean;
  connectionId: string;
  ownerUserId: string;
  transportCacheEntries: number;
  /** A human-readable account of the transport's state. */
  reason: string;
  /**
   * Where the owner must go to finish the server's authorization.
   *
   * It is present only while the server is waiting for the owner. It is the
   * server's own authorization URL, never a credential.
   */
  authUrl?: string;
  /** The state of the connection to the server. */
  state?: McpConnectionTransportState;
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
   * Make one connection usable for its owner.
   *
   * The broker opens the transport against the reviewed endpoint and, when the
   * server wants the owner's approval, returns the server's own authorization
   * URL so the owner can grant it. The credential stays in the broker: the
   * owner receives a URL, never a token.
   *
   * `reconnect` is the owner's explicit act: it discards the stored credential
   * and starts a fresh authorization, which is the only way a credential the
   * provider has refused can be replaced.
   */
  authorize(
    connectionId: string,
    ownerUserId: string,
    options?: { reconnect?: boolean }
  ): Promise<McpConnectionAuthorization>;
  /**
   * Read one reviewed tool.
   *
   * The broker revalidates the owner, the connection's status, and the
   * reviewed catalog before it reaches the provider, and it closes over the
   * credential so the credential never crosses back.
   */
  callTool(call: McpBrokerCall): Promise<McpBrokerCallResult>;
  destroy(connectionId: string, ownerUserId: string): Promise<void>;
  /**
   * Hand the server's OAuth callback to the broker that owns the connection.
   *
   * The broker holds the token, so the callback never reaches the browser
   * with anything but the server's own authorization code.
   */
  handleCallback(connectionId: string, request: Request): Promise<Response>;
}
