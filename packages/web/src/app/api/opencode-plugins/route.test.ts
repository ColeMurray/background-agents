import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { SETTINGS_PROXY_MAX_BODY_BYTES } from "@/lib/settings-proxy";
import { GET, POST } from "./route";
import { PUT, DELETE } from "./[id]/route";
const context = { params: Promise.resolve(undefined) };
const cookie = "__Secure-openinspect.session_token=session.signature";
function request(method: string, body?: string) {
  return new NextRequest("https://test.local/api/opencode-plugins", {
    method,
    headers: { Cookie: cookie },
    body,
  });
}
beforeEach(() => vi.resetAllMocks());
it("forwards malformed JSON to canonical validation and preserves 400", async () => {
  vi.mocked(controlPlaneUserFetch).mockResolvedValue(
    Response.json({ error: "Invalid JSON body" }, { status: 400 })
  );
  const response = await POST(request("POST", "{"), context);
  expect(response.status).toBe(400);
  expect(controlPlaneUserFetch).toHaveBeenCalledWith("/opencode-plugins", {
    method: "POST",
    body: "{",
  });
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
});
it("preserves non-JSON upstream errors and response headers", async () => {
  vi.mocked(controlPlaneUserFetch).mockResolvedValue(
    new Response("unavailable", { status: 503, headers: { "Retry-After": "30" } })
  );
  const response = await GET(request("GET"), context);
  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("30");
  expect(controlPlaneUserFetch).toHaveBeenCalledTimes(1);
});
it("caps mutation bodies before forwarding", async () => {
  const response = await POST(
    request("POST", "x".repeat(SETTINGS_PROXY_MAX_BODY_BYTES + 1)),
    context
  );
  expect(response.status).toBe(413);
  expect(controlPlaneUserFetch).not.toHaveBeenCalled();
});
it("encodes item IDs and forwards revision conditions for updates and deletes", async () => {
  vi.mocked(controlPlaneUserFetch).mockImplementation(async () => Response.json({ ok: true }));
  const itemContext = { params: Promise.resolve({ id: "a/b?#" }) };
  const update = request("PUT", '{"enabled":false}');
  update.headers.set("If-Match", '"2"');
  expect((await PUT(update, itemContext)).status).toBe(200);
  expect(controlPlaneUserFetch).toHaveBeenLastCalledWith("/opencode-plugins/a%2Fb%3F%23", {
    method: "PUT",
    headers: { "If-Match": '"2"' },
    body: '{"enabled":false}',
  });
  expect((await DELETE(request("DELETE"), itemContext)).status).toBe(200);
  expect(controlPlaneUserFetch).toHaveBeenLastCalledWith("/opencode-plugins/a%2Fb%3F%23", {
    method: "DELETE",
  });
});
