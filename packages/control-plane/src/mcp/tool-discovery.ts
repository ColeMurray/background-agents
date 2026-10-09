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
  type McpServerConfig,
  type McpToolMetadata,
} from "@open-inspect/shared/types/integrations";

const DISCOVERY_TIMEOUT_MS = 15_000;
const MAX_LIST_TOOLS_PAGES = 64;
const MAX_TOOL_DESCRIPTION_LENGTH = 2000;
// Statuses meaning the URL does not speak Streamable HTTP, so the SSE status explains more.
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

/**
 * Lists the tools a remote MCP server advertises, connecting with its stored
 * headers. Tries Streamable HTTP first and, when that is rejected with a 4xx
 * status, falls back to the legacy SSE transport, as the MCP specification
 * describes for backwards compatibility.
 */
export async function discoverRemoteMcpTools(
  server: McpServerConfig,
  { fetch: baseFetch = fetch, timeoutMs = DISCOVERY_TIMEOUT_MS }: DiscoveryOptions = {}
): Promise<McpToolMetadata[]> {
  if (server.type !== "remote" || !server.url) {
    throw new McpToolDiscoveryError("Only remote MCP servers can list their tools");
  }
  const url = new URL(server.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new McpToolDiscoveryError("The MCP server URL must use HTTP or HTTPS");
  }

  const timeout = AbortSignal.timeout(timeoutMs);
  const timedOut = (cause: unknown) =>
    new McpToolDiscoveryError(`The server did not respond within ${timeoutMs / 1000} seconds`, {
      cause,
    });
  const request = authenticatedFetch(server.headers ?? {}, timeout, baseFetch);

  let streamableError: unknown;
  let streamableStatus: number;
  try {
    return await listTools(new StreamableHTTPClientTransport(url, { fetch: request }), timeout);
  } catch (err) {
    if (err instanceof McpToolDiscoveryError) throw err;
    if (timeout.aborted) throw timedOut(err);
    const status = httpStatus(err);
    // Only a 4xx can mean a legacy SSE server; any other failure is the real one.
    if (status === undefined) throw err;
    if (status < 400 || status >= 500) throw statusError(status, err);
    streamableError = err;
    streamableStatus = status;
  }

  try {
    return await listTools(new SSEClientTransport(url, { fetch: request }), timeout);
  } catch (err) {
    if (err instanceof McpToolDiscoveryError) throw err;
    if (timeout.aborted) throw timedOut(err);
    const status = NOT_STREAMABLE_HTTP_STATUSES.has(streamableStatus)
      ? (httpStatus(err) ?? streamableStatus)
      : streamableStatus;
    throw statusError(status, new AggregateError([streamableError, err]));
  }
}
