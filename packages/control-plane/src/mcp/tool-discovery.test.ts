import type { FetchLike } from "@modelcontextprotocol/client";
import {
  MAX_MCP_SERVER_TOOLS,
  type McpServerConfig,
} from "@open-inspect/shared/types/integrations";
import { describe, expect, it, vi } from "vitest";
import {
  McpToolDiscoveryError,
  authenticatedFetch,
  discoverRemoteMcpTools,
} from "./tool-discovery";

const remoteServer: McpServerConfig = {
  id: "mcp-1",
  name: "docs",
  type: "remote",
  url: "https://mcp.example.com/mcp",
  headers: { Authorization: "Bearer secret", "X-Tenant": "acme" },
  repoScopes: null,
  toolAllowlist: null,
  enabled: true,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

/**
 * A Streamable HTTP MCP server that advertises `tools`, recording request
 * headers. With `stallToolsList`, it opens the tools/list response stream and
 * never answers.
 */
function streamableServer(
  tools: Array<{ name: string; description?: string }>,
  { stallToolsList = false } = {}
) {
  const requestHeaders: Headers[] = [];
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestHeaders.push(new Headers(init?.headers));
    if (init?.method === "GET") return new Response(null, { status: 405 });
    if (init?.method === "DELETE") return new Response(null, { status: 200 });
    const message = JSON.parse(String(init?.body)) as {
      id?: number;
      method: string;
      params?: { protocolVersion?: string };
    };
    if (message.method === "initialize") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "test-server", version: "1.0.0" },
        },
      });
    }
    if (message.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (message.method === "tools/list" && stallToolsList) {
      return new Response(new ReadableStream(), {
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (message.method === "tools/list") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: tools.map((tool) => ({ ...tool, inputSchema: { type: "object" } })),
        },
      });
    }
    throw new Error(`Unexpected MCP request: ${message.method}`);
  });
  return { fetchMock: fetchMock as unknown as FetchLike, requestHeaders };
}

/**
 * A legacy HTTP+SSE MCP server: Streamable HTTP POSTs to the URL get 405, a GET
 * opens the event stream, and answers to POSTed messages arrive on it.
 */
function legacySseServer(tools: Array<{ name: string }>) {
  const encoder = new TextEncoder();
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const send = (event: string, data: string) =>
    stream?.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/sse" && init?.method === "POST") {
      return new Response(null, { status: 405 });
    }
    if (url.pathname === "/sse") {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
          send("endpoint", "/messages");
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    const message = JSON.parse(String(init?.body)) as {
      id?: number;
      method: string;
      params?: { protocolVersion?: string };
    };
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "legacy-server", version: "1.0.0" },
          }
        : { tools: tools.map((tool) => ({ ...tool, inputSchema: { type: "object" } })) };
    if (message.id !== undefined) {
      send("message", JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    }
    return new Response(null, { status: 202 });
  });
  return { fetchMock };
}

describe("authenticatedFetch", () => {
  it("adds the server headers, honours both signals and drops the cache mode", async () => {
    const timeout = new AbortController();
    const transport = new AbortController();
    let forwarded: RequestInit | undefined;
    const baseFetch: FetchLike = vi.fn(async (_input, init) => {
      forwarded = init;
      return new Response(null, { status: 204 });
    });

    // The SSE transport sets `cache`, which the Workers RequestInit type does not declare.
    const init: RequestInit & { cache?: string } = {
      headers: { Accept: "application/json" },
      signal: transport.signal,
      cache: "no-store",
    };
    await authenticatedFetch(
      { Authorization: "Bearer secret" },
      timeout.signal,
      baseFetch
    )("https://mcp.example.com", init);

    const headers = new Headers(forwarded?.headers);
    expect(headers.get("authorization")).toBe("Bearer secret");
    expect(headers.get("accept")).toBe("application/json");
    expect(forwarded).not.toHaveProperty("cache");
    expect(forwarded?.signal?.aborted).toBe(false);
    transport.abort();
    expect(forwarded?.signal?.aborted).toBe(true);
  });
});

describe("discoverRemoteMcpTools", () => {
  it("lists tools trimmed, deduplicated and sorted, sending the stored headers", async () => {
    const { fetchMock, requestHeaders } = streamableServer([
      { name: " zebra ", description: "  Last tool  " },
      { name: "alpha", description: "First tool" },
      { name: "alpha", description: "Duplicate" },
      { name: "   " },
      { name: "plain" },
    ]);

    await expect(discoverRemoteMcpTools(remoteServer, { fetch: fetchMock })).resolves.toEqual([
      { name: "alpha", description: "First tool" },
      { name: "plain" },
      { name: "zebra", description: "Last tool" },
    ]);
    expect(requestHeaders).not.toHaveLength(0);
    for (const headers of requestHeaders) {
      expect(headers.get("authorization")).toBe("Bearer secret");
      expect(headers.get("x-tenant")).toBe("acme");
    }
  });

  it("falls back to the legacy SSE transport without the cache mode Workers rejects", async () => {
    const { fetchMock } = legacySseServer([{ name: "search" }]);

    await expect(
      discoverRemoteMcpTools(
        { ...remoteServer, url: "https://mcp.example.com/sse" },
        { fetch: fetchMock as unknown as FetchLike }
      )
    ).resolves.toEqual([{ name: "search" }]);
    const streamRequest = fetchMock.mock.calls.find(([, init]) => init?.method !== "POST");
    expect(streamRequest?.[1]).toBeDefined();
    expect(streamRequest?.[1]).not.toHaveProperty("cache");
    expect(new Headers(streamRequest?.[1]?.headers).get("authorization")).toBe("Bearer secret");
  });

  it("rejects a server advertising more tools than an allowlist can hold", async () => {
    const tools = Array.from({ length: MAX_MCP_SERVER_TOOLS + 1 }, (_, i) => ({ name: `t${i}` }));
    const { fetchMock } = streamableServer(tools);

    const err = await discoverRemoteMcpTools(remoteServer, { fetch: fetchMock }).catch((e) => e);
    expect(err).toBeInstanceOf(McpToolDiscoveryError);
    expect(err.message).toMatch(/more than 1000 tools/);
  });

  it.each([
    [401, 401, "The server returned HTTP 401; check its headers"],
    [405, 403, "The server returned HTTP 403; check its headers"],
    [404, 404, "The server returned HTTP 404"],
  ])(
    "falls back to SSE after Streamable HTTP %i and reports SSE %i by status only",
    async (streamableStatus, sseStatus, message) => {
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "POST"
          ? new Response("internal detail", { status: streamableStatus })
          : new Response("internal detail", { status: sseStatus })
      );

      const err = await discoverRemoteMcpTools(remoteServer, {
        fetch: fetchMock as unknown as FetchLike,
      }).catch((e) => e);
      expect(err).toBeInstanceOf(McpToolDiscoveryError);
      expect(err.message).toBe(message);
      expect(fetchMock.mock.calls.some(([, init]) => init?.method !== "POST")).toBe(true);
    }
  );

  it("reports a Streamable HTTP server error without trying SSE", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("internal detail", { status: 500 })
    );

    const err = await discoverRemoteMcpTools(remoteServer, {
      fetch: fetchMock as unknown as FetchLike,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(McpToolDiscoveryError);
    expect(err.message).toBe("The server returned HTTP 500");
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === "POST")).toBe(true);
  });

  it("rethrows a failure without an HTTP status unchanged and does not try SSE", async () => {
    const failure = new TypeError("fetch failed");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      throw failure;
    });

    const err = await discoverRemoteMcpTools(remoteServer, {
      fetch: fetchMock as unknown as FetchLike,
    }).catch((e) => e);
    expect(err).not.toBeInstanceOf(McpToolDiscoveryError);
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === "POST")).toBe(true);
  });

  it("reports a timeout without trying SSE", async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        })
    );

    const err = await discoverRemoteMcpTools(remoteServer, {
      fetch: fetchMock as unknown as FetchLike,
      timeoutMs: 20,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(McpToolDiscoveryError);
    expect(err.message).toMatch(/did not respond within/);
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === "POST")).toBe(true);
  });

  it("bounds a tools/list response that never arrives by the timeout", async () => {
    const { fetchMock } = streamableServer([], { stallToolsList: true });

    const err = await discoverRemoteMcpTools(remoteServer, {
      fetch: fetchMock,
      timeoutMs: 50,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(McpToolDiscoveryError);
    expect(err.message).toMatch(/did not respond within/);
  }, 5_000);

  it.each<[string, McpServerConfig]>([
    ["a local server", { ...remoteServer, type: "local", url: undefined, command: ["npx"] }],
    ["a non-HTTP URL", { ...remoteServer, url: "ftp://mcp.example.com" }],
  ])("refuses %s without connecting", async (_case, server) => {
    const fetchMock = vi.fn() as unknown as FetchLike;
    await expect(discoverRemoteMcpTools(server, { fetch: fetchMock })).rejects.toBeInstanceOf(
      McpToolDiscoveryError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
