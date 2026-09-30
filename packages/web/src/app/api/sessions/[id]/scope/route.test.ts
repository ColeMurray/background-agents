import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { PUT } from "./route";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
const context = { params: Promise.resolve({ id: "session/id" }) };
function request(body: string, cookie = true) {
  return new NextRequest("http://localhost/api/sessions/session%2Fid/scope", {
    method: "PUT",
    headers: cookie ? { Cookie: "__Secure-openinspect.session_token=session.signature" } : {},
    body,
  });
}

describe("scope BFF", () => {
  it("forwards null scope and explicit cascade/join choices through user-scoped service identity", async () => {
    const body = JSON.stringify({ teamId: null, includeChildren: false, joinTeam: false });
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ affectedSessionIds: ["session/id"] })
    );
    const response = await PUT(request(body), context);
    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/sessions/session%2Fid/scope", {
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
    [403, { error: "Forbidden", code: "session_action_denied", reason_code: "not_member" }],
    [404, { error: "Session not found" }],
    [409, { error: "Denied", code: "descendant_inaccessible" }],
    [
      409,
      {
        error: "Target team lacks repository grant",
        code: "target_team_missing_grant",
        repository: "group/subgroup/repo",
      },
    ],
  ])("preserves server status %s and payload %j", async (status, failure) => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json(failure, { status }));
    const response = await PUT(request("{}"), context);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(failure);
  });
});
