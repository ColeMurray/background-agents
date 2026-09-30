import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { PUT, DELETE } from "./route";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
const context = { params: Promise.resolve({ id: "session/id", userId: "user/id" }) };
function request(method: string, cookie = true) {
  return new NextRequest("http://localhost/api/sessions/session%2Fid/collaborators/user%2Fid", {
    method,
    headers: cookie ? { Cookie: "__Secure-openinspect.session_token=session.signature" } : {},
  });
}

describe("collaborators BFF", () => {
  it.each([
    ["PUT", PUT],
    ["DELETE", DELETE],
  ] as const)(
    "forwards bodyless %s through the user-scoped service boundary",
    async (method, handler) => {
      vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ status: "updated" }));
      const response = await handler(request(method), context);
      expect(controlPlaneUserFetch).toHaveBeenCalledWith(
        "/sessions/session%2Fid/collaborators/user%2Fid",
        { method, ...(method === "PUT" ? { body: "" } : {}) }
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
  );
  it("rejects an unauthenticated PUT", async () => {
    expect((await PUT(request("PUT", false), context)).status).toBe(401);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });
  it.each([
    [403, { error: "Forbidden", reason_code: "not_owner" }],
    [404, { error: "User not found" }],
    [409, { error: "User inactive", code: "user_inactive" }],
  ])("preserves collaborator status %s and payload %j", async (status, failure) => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json(failure, { status }));
    const response = await PUT(request("PUT"), context);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(failure);
  });
  it("delegates DELETE authentication and preserves no-content responses", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(new Response(null, { status: 204 }));
    const response = await DELETE(request("DELETE"), context);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });
});
