import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET as listConnections } from "./route";
import { DELETE as disconnect } from "./[serverId]/route";
import { POST as connect } from "./[serverId]/connect/route";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

const params = { params: Promise.resolve({ serverId: "server/other?key=value#fragment" }) };

const routes = [
  {
    name: "GET /api/mcp-connections",
    call: () => listConnections(),
    forwarded: ["/mcp-connections"],
    body: { connections: [] },
    failure: "Failed to fetch MCP connections",
  },
  {
    name: "POST /api/mcp-connections/[serverId]/connect",
    call: () =>
      connect(
        new Request("http://localhost/api/mcp-connections/server-1/connect", { method: "POST" }),
        params
      ),
    forwarded: [
      "/mcp-connections/server%2Fother%3Fkey%3Dvalue%23fragment/connect",
      { method: "POST" },
    ],
    body: { authorizationUrl: "https://issuer.example.com/authorize" },
    failure: "Failed to start MCP connection",
  },
  {
    name: "DELETE /api/mcp-connections/[serverId]",
    call: () =>
      disconnect(
        new Request("http://localhost/api/mcp-connections/server-1", { method: "DELETE" }),
        params
      ),
    forwarded: ["/mcp-connections/server%2Fother%3Fkey%3Dvalue%23fragment", { method: "DELETE" }],
    body: { ok: true },
    failure: "Failed to disconnect MCP connection",
  },
];

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.restoreAllMocks());

describe.each(routes)("$name", ({ call, forwarded, body, failure }) => {
  it("forwards to the control plane and relays its JSON response", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json(body, { headers: { "x-request-id": "request-1" } })
    );

    const response = await call();

    expect(controlPlaneUserFetch).toHaveBeenCalledExactlyOnceWith(...forwarded);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(body);
    expect(response.headers.get("x-request-id")).toBe("request-1");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it.each([
    { status: 401, text: "Unauthorized", contentType: "text/plain" },
    { status: 502, text: "<html>Bad gateway</html>", contentType: "text/html" },
  ])("keeps the status of a non-JSON upstream $status", async ({ status, text, contentType }) => {
    // A layer in front of the control plane can answer with text or HTML;
    // the browser acts on the status, so a parse failure must not replace it.
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      new Response(text, {
        status,
        headers: { "Content-Type": contentType, "Retry-After": "30" },
      })
    );

    const response = await call();

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({
      error: "Unexpected response from control plane",
    });
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("returns a JSON error when forwarding fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(controlPlaneUserFetch).mockRejectedValue(new Error("Connection refused"));

    const response = await call();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: failure });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
