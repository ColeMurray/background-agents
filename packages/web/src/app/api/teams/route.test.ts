import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET } from "./route";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

describe("Teams settings list proxy", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns the all-teams response without a second request when authorized", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ teams: [{ id: "team_design" }] })
    );
    const result = await GET(new NextRequest("http://localhost/api/teams"));
    await expect(result.json()).resolves.toEqual({ teams: [{ id: "team_design" }] });
    expect(controlPlaneUserFetch).toHaveBeenCalledTimes(1);
  });

  it("uses memberships when the all-teams route denies a lead without sessions.read", async () => {
    vi.mocked(controlPlaneUserFetch)
      .mockResolvedValueOnce(Response.json({ error: "Forbidden" }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ teams: [{ id: "team_design", role: "lead" }] }));
    const result = await GET(new NextRequest("http://localhost/api/teams"));
    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({ teams: [{ id: "team_design", role: "lead" }] });
    expect(vi.mocked(controlPlaneUserFetch).mock.calls.map(([path]) => path)).toEqual([
      "/teams?membership=all&includeArchived=true",
      "/me/teams",
    ]);
  });

  it("does not hide a denial when the membership route also denies the caller", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "Forbidden" }, { status: 403 })
    );
    const result = await GET(new NextRequest("http://localhost/api/teams"));
    expect(result.status).toBe(403);
    expect(controlPlaneUserFetch).toHaveBeenCalledTimes(2);
  });
});
