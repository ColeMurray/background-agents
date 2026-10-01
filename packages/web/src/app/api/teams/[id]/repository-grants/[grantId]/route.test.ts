import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { DELETE } from "./route";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

describe("delete team repository grant proxy", () => {
  it("encodes both IDs and preserves a bodyless 204", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(new Response(null, { status: 204 }));
    const request = new NextRequest(
      "http://localhost/api/teams/one/repository-grants/grant?teamId=other",
      { method: "DELETE" }
    );
    const response = await DELETE(request, {
      params: Promise.resolve({ id: "team/one", grantId: "grant/one" }),
    });
    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/teams/team%2Fone/repository-grants/grant%2Fone",
      { method: "DELETE" }
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it.each([401, 403, 404, 409])("preserves an upstream %s denial", async (status) => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "Denied" }, { status })
    );
    const response = await DELETE(
      new NextRequest("http://localhost/api/teams/one/repository-grants/grant", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "team-1", grantId: "grant-1" }) }
    );
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: "Denied" });
  });
});
