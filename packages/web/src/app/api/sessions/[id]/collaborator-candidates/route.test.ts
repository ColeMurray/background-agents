import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET } from "./route";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

describe("collaborator candidates BFF", () => {
  beforeEach(() => vi.resetAllMocks());

  it("relays only the scoped GET with encoded session identity and no caching", async () => {
    const candidates = [{ userId: "ada", displayName: "Ada", email: null, avatarUrl: null }];
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json(candidates));
    const response = await GET(
      new NextRequest("http://local/api/sessions/session%2Fid/collaborator-candidates"),
      { params: Promise.resolve({ id: "session/id" }) }
    );
    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/sessions/session%2Fid/collaborator-candidates",
      undefined
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual(candidates);
  });

  it.each([
    [401, { error: "Unauthorized" }],
    [403, { error: "Forbidden", code: "session_action_denied", reason_code: "not_owner_or_lead" }],
    [404, { error: "Session not found" }],
  ])("preserves upstream status %s and its error contract", async (status, body) => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json(body, { status }));
    const response = await GET(new NextRequest("http://local"), {
      params: Promise.resolve({ id: "private-session" }),
    });
    expect(response.status).toBe(status);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual(body);
  });
});
