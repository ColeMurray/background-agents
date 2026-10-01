import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { DELETE } from "./route";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

describe("Team secret delete proxy", () => {
  it("encodes both resource segments and forwards DELETE without a body", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ success: true }));

    const response = await DELETE(
      new NextRequest("http://localhost/api/teams/team_one/secrets/API_TOKEN", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "team_one/other", key: "TOKEN/NAME?value=secret" }) }
    );

    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/teams/team_one%2Fother/secrets/TOKEN%2FNAME%3Fvalue%3Dsecret",
      { method: "DELETE" }
    );
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it.each([401, 403, 404])("preserves upstream DELETE denial %s", async (status) => {
    const denial = { error: "Denied", reason_code: "not_owner_or_lead" };
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json(denial, { status }));

    const response = await DELETE(
      new NextRequest("http://localhost/api/teams/team_one/secrets/API_TOKEN", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "team_one", key: "API_TOKEN" }) }
    );

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual(denial);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(controlPlaneUserFetch).toHaveBeenCalledOnce();
  });
});
