import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET, PATCH } from "./route";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

describe("team settings proxy", () => {
  const context = { params: Promise.resolve(undefined) };

  beforeEach(() => vi.resetAllMocks());

  it("relays the policy on GET without caching", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ requireTeamOnCreate: true })
    );

    const response = await GET(new NextRequest("http://localhost/api/settings/teams"), context);

    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/settings/teams", undefined);
    await expect(response.json()).resolves.toEqual({ requireTeamOnCreate: true });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("forwards the PATCH body and relays permission failures", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "Forbidden" }, { status: 403 })
    );
    const body = JSON.stringify({ requireTeamOnCreate: true });
    const response = await PATCH(
      new NextRequest("http://localhost/api/settings/teams", {
        method: "PATCH",
        headers: { Cookie: "__Secure-openinspect.session_token=session.signature" },
        body,
      }),
      context
    );

    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/settings/teams", {
      method: "PATCH",
      body,
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
  });
});
