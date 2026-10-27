import {
  Client,
  SdkHttpError,
  SseError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type FetchLike,
  type Transport,
} from "@modelcontextprotocol/client";
import {
  MAX_MCP_SERVER_TOOLS,
  type McpToolMetadata,
} from "@open-inspect/shared/types/integrations";

const DISCOVERY_TIMEOUT_MS = 15_000;
const MAX_LIST_TOOLS_PAGES = 64;
const MAX_TOOL_DESCRIPTION_LENGTH = 2000;
// Statuses meaning the URL does not speak Streamable HTTP.
const NOT_STREAMABLE_HTTP_STATUSES = new Set([404, 405]);

export class McpToolDiscoveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "McpToolDiscoveryError";
  }
}

/**
 * Sends the server's configured headers on every request, bounded by `signal`.
 * Drops `cache`: the SSE transport's EventSource sets `cache: "no-store"`, which
 * the Workers runtime rejects at the control plane's compatibility date.
 */
export function authenticatedFetch(
  headers: Record<string, string>,
  signal: AbortSignal,
  baseFetch: FetchLike
): FetchLike {
  return (input, init) => {
    // Typed explicitly: the Workers RequestInit type has no `cache` field.
    const { cache: _cache, ...forwarded }: RequestInit & { cache?: unknown } = init ?? {};
    const requestHeaders = new Headers(headers);
    for (const [name, value] of new Headers(forwarded.headers)) requestHeaders.set(name, value);
    const requestSignal = forwarded.signal;
    return baseFetch(input, {
      ...forwarded,
      headers: requestHeaders,
      signal: requestSignal ? AbortSignal.any([signal, requestSignal]) : signal,
    });
  };
}

async function listTools(transport: Transport, signal: AbortSignal): Promise<McpToolMetadata[]> {
  const client = new Client(
    { name: "open-inspect-settings", version: "1.0.0" },
    { listMaxPages: MAX_LIST_TOOLS_PAGES }
  );
  try {
    // Aborting a fetch does not settle a request whose response stream stalls.
    await client.connect(transport, { signal });
    const { tools } = await client.listTools(undefined, { signal });
    if (tools.length > MAX_MCP_SERVER_TOOLS) {
      throw new McpToolDiscoveryError(
        `The server advertises more than ${MAX_MCP_SERVER_TOOLS} tools`
      );
    }
    const byName = new Map<string, McpToolMetadata>();
    for (const tool of tools) {
      const name = tool.name.trim();
      if (!name || byName.has(name)) continue;
      const description = tool.description?.trim().slice(0, MAX_TOOL_DESCRIPTION_LENGTH);
      byName.set(name, description ? { name, description } : { name });
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    await client.close().catch(() => undefined);
  }
}

function httpStatus(err: unknown): number | undefined {
  if (err instanceof SdkHttpError) return err.status;
  if (err instanceof SseError) return err.code;
  return undefined;
}

/**
 * Reports only the HTTP status, because SDK error messages can quote the
 * server's response body.
 */
function statusError(status: number, cause: unknown): McpToolDiscoveryError {
  const hint = status === 401 || status === 403 ? "; check its headers" : "";
  return new McpToolDiscoveryError(`The server returned HTTP ${status}${hint}`, { cause });
}

interface DiscoveryOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
}

/** A remote MCP server's connection settings. */
export interface RemoteMcpServer {
  url: string;
  headers: Record<string, string>;
}

type ListToolsAttempt =
  { tools: McpToolMetadata[] } | { error: unknown; status: number | undefined };

/**
 * Lists the tools a remote MCP server advertises, connecting with the given
 * headers. Tries Streamable HTTP first and, when that is rejected with a 4xx
 * status, falls back to the legacy SSE transport, as the MCP specification
 * describes for backwards compatibility.
 */
export async function discoverRemoteMcpTools(
  server: RemoteMcpServer,
  { fetch: baseFetch = fetch, timeoutMs = DISCOVERY_TIMEOUT_MS }: DiscoveryOptions = {}
): Promise<McpToolMetadata[]> {
  const url = new URL(server.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new McpToolDiscoveryError("The MCP server URL must use HTTP or HTTPS");
  }

  const timeout = AbortSignal.timeout(timeoutMs);
  const request = authenticatedFetch(server.headers, timeout, baseFetch);
  // Throws discovery errors and timeouts as McpToolDiscoveryError; returns any
  // other failure, with its HTTP status, for the caller to judge.
  const attempt = async (transport: Transport): Promise<ListToolsAttempt> => {
    try {
      return { tools: await listTools(transport, timeout) };
    } catch (err) {
      if (err instanceof McpToolDiscoveryError) throw err;
      if (timeout.aborted) {
        throw new McpToolDiscoveryError(
          `The server did not respond within ${timeoutMs / 1000} seconds`,
          { cause: err }
        );
      }
      return { error: err, status: httpStatus(err) };
    }
  };

  const streamable = await attempt(new StreamableHTTPClientTransport(url, { fetch: request }));
  if ("tools" in streamable) return streamable.tools;
  // Only a 4xx can mean a legacy SSE server; any other failure is the real one.
  if (streamable.status === undefined) throw streamable.error;
  if (streamable.status < 400 || streamable.status >= 500) {
    throw statusError(streamable.status, streamable.error);
  }

  const sse = await attempt(new SSEClientTransport(url, { fetch: request }));
  if ("tools" in sse) return sse.tools;
  // Those statuses only say the URL does not speak Streamable HTTP, so the SSE
  // status explains more; any other 4xx, such as a 401, is the real answer.
  const status = NOT_STREAMABLE_HTTP_STATUSES.has(streamable.status)
    ? (sse.status ?? streamable.status)
    : streamable.status;
  throw statusError(status, new AggregateError([streamable.error, sse.error]));
}
