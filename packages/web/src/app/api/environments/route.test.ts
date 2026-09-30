import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET } from "./route";

vi.mock("@/lib/server-auth-session", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

describe("environments list proxy", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } });
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ environments: [] }));
  });

  it("forwards only teamId", async () => {
    await GET(
      new NextRequest("http://localhost/api/environments?teamId=team%2Fone&scope=all&grants=admin")
    );
    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/environments?teamId=team%2Fone");
  });

  it("keeps workspace requests unscoped", async () => {
    await GET(new NextRequest("http://localhost/api/environments"));
    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/environments");
  });

  it("preserves list denials", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "Forbidden" }, { status: 403 })
    );
    const response = await GET(new NextRequest("http://localhost/api/environments?teamId=team-1"));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
  });
});
