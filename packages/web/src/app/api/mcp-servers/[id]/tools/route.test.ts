import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { POST } from "./route";

vi.mock("@/lib/server-auth-session", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

const loadTools = () =>
  POST(new NextRequest("http://localhost/api/mcp-servers/mcp%2F1/tools", { method: "POST" }), {
    params: Promise.resolve({ id: "mcp/1" }),
  });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } });
});

it("relays the server's tools from the control plane", async () => {
  vi.mocked(controlPlaneUserFetch).mockResolvedValue(
    Response.json({ tools: [{ name: "search" }] })
  );

  const response = await loadTools();

  expect(controlPlaneUserFetch).toHaveBeenCalledWith("/mcp-servers/mcp%2F1/tools", {
    method: "POST",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ tools: [{ name: "search" }] });
});

it("keeps the status of an error response whose body is not JSON", async () => {
  vi.mocked(controlPlaneUserFetch).mockResolvedValue(
    new Response("<html>Bad gateway</html>", { status: 502 })
  );

  const response = await loadTools();

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "Unexpected response from control plane" });
});

it("refuses a signed-out request without calling the control plane", async () => {
  vi.mocked(getServerAuthSession).mockResolvedValue(null);

  const response = await loadTools();

  expect(response.status).toBe(401);
  expect(controlPlaneUserFetch).not.toHaveBeenCalled();
});
