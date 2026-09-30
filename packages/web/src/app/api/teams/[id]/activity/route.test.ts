import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET } from "./route";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

describe("GET team activity proxy", () => {
  it.each([401, 403, 404])(
    "preserves upstream %s before interpreting invalid filters or bodies",
    async (status) => {
      vi.mocked(controlPlaneUserFetch).mockResolvedValue(new Response("not JSON", { status }));
      const response = await GET(
        new NextRequest(
          "http://localhost/api/teams/team_one/activity?limit=invalid&cursor=invalid"
        ),
        { params: Promise.resolve({ id: "team_one" }) }
      );
      expect(controlPlaneUserFetch).toHaveBeenCalledOnce();
      expect(response.status).toBe(status);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
  );

  it("relays the audit page contract unchanged", async () => {
    const page = { events: [], hasMore: true, nextCursor: "opaque/+cursor" };
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json(page));
    const response = await GET(
      new NextRequest("http://localhost/api/teams/team_one/activity?limit=25"),
      { params: Promise.resolve({ id: "team_one" }) }
    );
    await expect(response.json()).resolves.toEqual(page);
  });

  it("encodes the team ID and forwards only pagination and action parameters", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "Unauthorized" }, { status: 401 })
    );
    const response = await GET(
      new NextRequest(
        "http://localhost/api/teams/id/activity?limit=25&cursor=opaque%2Fcursor&action=session.moved&teamId=other"
      ),
      { params: Promise.resolve({ id: "team/id" }) }
    );
    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/teams/team%2Fid/activity?limit=25&cursor=opaque%2Fcursor&action=session.moved",
      undefined
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
