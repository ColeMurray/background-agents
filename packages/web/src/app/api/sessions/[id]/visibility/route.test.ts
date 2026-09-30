import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { PUT } from "./route";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
const context = { params: Promise.resolve({ id: "session/id" }) };
function request(body: string, cookie = true) {
  return new NextRequest("http://localhost/api/sessions/session%2Fid/visibility", {
    method: "PUT",
    headers: cookie ? { Cookie: "__Secure-openinspect.session_token=session.signature" } : {},
    body,
  });
}

describe("visibility BFF", () => {
  it("forwards visibility and cascade choices unchanged through the user service boundary", async () => {
    const body = JSON.stringify({ visibility: "private", includeChildren: true });
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ visibility: "private" }));
    const response = await PUT(request(body), context);
    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/sessions/session%2Fid/visibility", {
      method: "PUT",
      body,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it("rejects an unauthenticated mutation", async () => {
    expect((await PUT(request("{}", false), context)).status).toBe(401);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });
  it.each([
    [400, { error: "Session owner required", code: "owner_required" }],
    [400, { error: "A team is required", code: "team_required" }],
    [403, { error: "Forbidden", reason_code: "not_owner" }],
    [404, { error: "Session not found" }],
    [409, { error: "Denied", code: "descendant_inaccessible" }],
  ])("preserves server status %s and payload %j", async (status, failure) => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json(failure, { status }));
    const response = await PUT(request("{}"), context);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(failure);
  });
});
