import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET } from "./route";

vi.mock("@/lib/server-auth-session", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

describe("repositories list proxy", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } });
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ repos: [], cached: false, cachedAt: "2026-10-01T00:00:00Z" })
    );
  });

  it("forwards only teamId", async () => {
    await GET(
      new NextRequest("http://localhost/api/repos?teamId=team%2Fone&scope=all&grants=admin")
    );
    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/repos?teamId=team%2Fone");
  });

  it("keeps workspace requests unscoped", async () => {
    await GET(new NextRequest("http://localhost/api/repos"));
    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/repos");
  });

  it.each([true, false])(
    "preserves authoritative team grant metadata (%s)",
    async (teamHasRepositoryGrants) => {
      vi.mocked(controlPlaneUserFetch).mockResolvedValue(
        Response.json({
          repos: [],
          cached: false,
          cachedAt: "2026-10-01T00:00:00Z",
          teamHasRepositoryGrants,
        })
      );
      const response = await GET(new NextRequest("http://localhost/api/repos?teamId=team-1"));
      await expect(response.json()).resolves.toEqual({ repos: [], teamHasRepositoryGrants });
    }
  );

  it("does not invent grant metadata for the installation catalog", async () => {
    const response = await GET(new NextRequest("http://localhost/api/repos"));
    await expect(response.json()).resolves.toEqual({ repos: [] });
  });

  it("does not fetch without authentication", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue(null);
    expect((await GET(new NextRequest("http://localhost/api/repos?teamId=team-1"))).status).toBe(
      401
    );
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });
});
