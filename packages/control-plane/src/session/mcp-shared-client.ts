import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { collectCredentialValues, containsCredentialValue } from "../mcp/credential-values";
import { assertMcpEgress } from "../mcp/egress-policy";

/**
 * The shared MCP lane.
 *
 * A shared server belongs to the deployment. Its credential is the
 * deployment's own — a static header or env blob on the server row — so
 * nothing here is per-user: no owner, no OAuth dance, no callback, no
 * per-user keyring. The credential is closed over inside this call and never
 * crosses back to the agent.
 *
 * The lane is the one the sandbox already uses, reached the same way: the
 * session's repositories decide which servers exist for the session.
 */

/** One shared server, as the session resolved it. */
export interface McpSharedServer {
  readonly id: string;
  readonly name: string;
  readonly type: "local" | "remote";
  readonly url?: string;
  /** The exact host from the stored server configuration. */
  readonly endpointHost: string;
  readonly headers?: Record<string, string>;
  readonly env?: Record<string, string>;
}

/** The longest one shared tool call may take. */
export const MCP_SHARED_CALL_TIMEOUT_MS = 30_000;

/**
 * Call one reviewed tool on a shared server.
 *
 * The credential is used and forgotten: the call opens a client, makes one
 * request, and closes it. The provider's own error never leaves this
 * function — the caller learns only that the call did not complete.
 */
export async function callSharedMcpTool(
  server: McpSharedServer,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number = MCP_SHARED_CALL_TIMEOUT_MS
): Promise<unknown> {
  if (server.type !== "remote" || !server.url) {
    // A local server is a process on the sandbox, not a URL. The sandbox
    // runs it; this lane cannot.
    throw new Error("This shared MCP server is not reachable from the session");
  }
  // Validate the candidate before constructing a transport or handing static
  // headers to it. Shared and personal MCP use the same enforceable egress
  // policy rather than creating a second source of authority.
  assertMcpEgress({ endpointHost: server.endpointHost }, server.url);
  const credentialValues = collectCredentialValues(server.headers, server.env);
  const client = new Client({ name: "open-inspect", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: server.headers ?? {} },
  });
  const deadline = AbortSignal.timeout(timeoutMs);
  try {
    await client.connect(transport, { signal: deadline });
    const result = await client.callTool({ name: toolName, arguments: args }, { signal: deadline });
    if (containsCredentialValue(result.content, credentialValues)) {
      throw new Error("The MCP tool returned unsafe content");
    }
    return result.content ?? null;
  } catch {
    // The provider's own string stays inside the platform.
    throw new Error("The MCP tool did not complete");
  } finally {
    await client.close().catch(() => undefined);
  }
}
