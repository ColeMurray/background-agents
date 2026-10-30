import { mcpDestination } from "./destination";
import { McpError } from "./errors";
import type { McpFetch } from "./oauth";

export const MCP_MAX_BODY_BYTES = 1024 * 1024;
export const MCP_UPSTREAM_HEADERS_TIMEOUT_MS = 5 * 60_000;
export const MCP_STREAM_TIMEOUT_MS = 30 * 60_000;
export const MCP_REQUEST_BODY_TIMEOUT_MS = 15_000;
const REQUEST_HEADERS = [
  "accept",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
];
const RESPONSE_HEADERS = ["content-type", "mcp-protocol-version", "mcp-session-id", "retry-after"];
const FORBIDDEN_SERVICE_HEADERS =
  /^(host|origin|cookie|set-cookie|connection|keep-alive|transfer-encoding|te|trailer|upgrade|proxy-.*|forwarded|x-forwarded-.*|content-length)$/i;

export async function readMcpBody(
  request: Request,
  limit = MCP_MAX_BODY_BYTES
): Promise<Uint8Array | undefined> {
  if (Number(request.headers.get("content-length")) > limit)
    throw new McpError("mcp_request_too_large", 413);
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const timeout = setTimeout(() => {
    void reader.cancel(new Error("MCP body deadline exceeded")).catch(() => {});
  }, MCP_REQUEST_BODY_TIMEOUT_MS);
  const deadline = Date.now() + MCP_REQUEST_BODY_TIMEOUT_MS;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (Date.now() >= deadline) throw new McpError("mcp_unavailable", 408);
      if (done) break;
      size += value.length;
      if (size > limit) throw new McpError("mcp_request_too_large", 413);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

async function isEmptyBody(body: ReadableStream<Uint8Array>): Promise<boolean> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return true;
      if (value.length) return false;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Exactly one forwarding attempt. No JSON-RPC client, native auth, retries or response buffering. */
export async function relayMcpRequest(
  request: Request,
  options: {
    target: string;
    upstreamHeaders: Record<string, string>;
    personal: boolean;
    revalidate: () => Promise<void>;
    fetcher?: McpFetch;
    body?: Uint8Array;
    bodyRead?: boolean;
    onComplete?: () => void;
  }
): Promise<Response> {
  if (!["POST", "GET", "DELETE"].includes(request.method))
    throw new McpError("mcp_unsupported", 405);
  const target = mcpDestination(options.target);
  const body = options.bodyRead ? options.body : await readMcpBody(request);
  const headers = new Headers();
  for (const key of REQUEST_HEADERS) {
    const value = request.headers.get(key);
    if (value) headers.set(key, value);
  }
  for (const [key, value] of Object.entries(options.upstreamHeaders)) {
    if (FORBIDDEN_SERVICE_HEADERS.test(key)) throw new McpError("mcp_unsupported");
    headers.set(key, value);
  }
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let completed = false;
  const cleanup = () => {
    if (timer !== undefined) clearTimeout(timer);
    request.signal.removeEventListener("abort", onAbort);
    if (!completed) {
      completed = true;
      options.onComplete?.();
    }
  };
  const onAbort = () => {
    abort.abort();
    // A backpressured consumer may never pull again to observe the aborted
    // upstream stream. Release its lease at cancellation, not at the next read.
    cleanup();
  };
  timer = setTimeout(onAbort, MCP_UPSTREAM_HEADERS_TIMEOUT_MS);
  request.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal.aborted) onAbort();
  let upstream: Response | undefined;
  try {
    await options.revalidate();
    if (abort.signal.aborted) throw new McpError("mcp_unavailable", 503);
    upstream = await (options.fetcher ?? ((req) => fetch(req)))(
      new Request(target, {
        method: request.method,
        headers,
        body: body?.buffer as ArrayBuffer | undefined,
        redirect: "manual",
        signal: abort.signal,
      })
    );
    if (upstream.status >= 300 && upstream.status < 400) throw new McpError("mcp_unsupported");
    if (upstream.status === 401)
      throw new McpError(options.personal ? "mcp_reconnect_required" : "mcp_denied");
    // HTTP adapters may represent an empty 202 acknowledgement as a zero-byte
    // body stream. MCP notifications acknowledge with 202 and no content type.
    if (upstream.status === 202) {
      await upstream.body?.cancel();
      upstream = new Response(null, { status: 202, headers: upstream.headers });
    }
    const media = upstream.headers.get("content-type")?.split(";")[0].trim();
    if (upstream.body && media !== "application/json" && media !== "text/event-stream") {
      if (upstream.status < 400) {
        // Untyped success bodies are only acceptable when empty, e.g. a 200
        // acknowledging DELETE; anything else is not an MCP transport response.
        if (media || !(await isEmptyBody(upstream.body))) throw new McpError("mcp_unsupported");
        upstream = new Response(null, { status: upstream.status, headers: upstream.headers });
      } else {
        // Real HTTP adapters expose empty errors as body streams. Keep status
        // semantics (notably missing-session 404 and optional-GET 405), but never
        // forward gateway HTML/diagnostics or interpret/replay the failed request.
        await upstream.body.cancel();
        const errorHeaders = new Headers(upstream.headers);
        errorHeaders.delete("content-type");
        upstream = new Response(null, { status: upstream.status, headers: errorHeaders });
      }
    }
  } catch (error) {
    abort.abort();
    await upstream?.body?.cancel().catch(() => {});
    cleanup();
    throw error instanceof McpError ? error : new McpError("mcp_unavailable", 503);
  }
  const responseHeaders = new Headers({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  for (const key of RESPONSE_HEADERS) {
    const value = upstream.headers.get(key);
    if (value) responseHeaders.set(key, value);
  }
  clearTimeout(timer);
  if (!upstream.body) {
    cleanup();
    return new Response(null, { status: upstream.status, headers: responseHeaders });
  }
  timer = setTimeout(onAbort, MCP_STREAM_TIMEOUT_MS);
  const reader = upstream.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          cleanup();
          controller.close();
        } else controller.enqueue(value);
      } catch {
        cleanup();
        controller.error(new Error("MCP stream interrupted; operation outcome may be unknown"));
      }
    },
    async cancel() {
      abort.abort();
      cleanup();
      await reader.cancel().catch(() => {});
    },
  });
  return new Response(stream, { status: upstream.status, headers: responseHeaders });
}
