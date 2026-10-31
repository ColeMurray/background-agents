import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { POST } from "./route";

vi.mock("@/lib/server-auth-session", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

function revoke(id = "server-1") {
  return POST(
    new Request("http://localhost/api/mcp-servers/server-1/revoke-connections", {
      method: "POST",
    }),
    { params: Promise.resolve({ id }) }
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } });
});
afterEach(() => vi.restoreAllMocks());

describe("MCP server connection revocation proxy", () => {
  it("rejects an unauthenticated request without forwarding", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue(null);

    const response = await revoke();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("encodes the server ID and forwards a bodyless POST", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ ok: true }));

    const response = await revoke("server/other?key=value#fragment");

    expect(controlPlaneUserFetch).toHaveBeenCalledExactlyOnceWith(
      "/mcp-servers/server%2Fother%3Fkey%3Dvalue%23fragment/revoke-connections",
      { method: "POST" }
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("relays the upstream 409 explanation and response headers", async () => {
    const body = { error: "Disable this MCP server before revoking its connections" };
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json(body, { status: 409, headers: { "x-request-id": "request-1" } })
    );

    const response = await revoke();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(body);
    expect(response.headers.get("x-request-id")).toBe("request-1");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it.each([401, 502])(
    "sanitizes a non-JSON upstream error without losing status %s",
    async (status) => {
      vi.mocked(controlPlaneUserFetch).mockResolvedValue(
        new Response("<html>Private gateway diagnostics</html>", {
          status,
          headers: { "Content-Type": "text/html", "Retry-After": "30" },
        })
      );

      const response = await revoke();

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({
        error: "Unexpected response from control plane",
      });
      expect(response.headers.get("Retry-After")).toBe("30");
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
  );

  it("returns a JSON error when forwarding fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(controlPlaneUserFetch).mockRejectedValue(new Error("Connection refused"));

    const response = await revoke();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Failed to revoke MCP connections" });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
