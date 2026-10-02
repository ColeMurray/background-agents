import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET } from "./route";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

describe("session snapshot BFF", () => {
  it.each([200, 401, 403, 404])("preserves the server snapshot status %s", async (status) => {
    const body =
      status === 200
        ? { session: { ownerTeamId: "team_one", visibility: "private", collaborators: [] } }
        : { error: "Session not found" };
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json(body, { status }));
    const response = await GET(new NextRequest("http://localhost/api/sessions/session%2Fid"), {
      params: Promise.resolve({ id: "session/id" }),
    });
    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/sessions/session%2Fid", undefined);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
