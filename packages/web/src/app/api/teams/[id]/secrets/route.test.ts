import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET, PUT } from "./route";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

describe("Team secrets proxy", () => {
  it("lists key metadata with an encoded team id and no-store headers", async () => {
    const metadata = { secrets: [{ key: "API_TOKEN", createdAt: 1, updatedAt: 2 }] };
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json(metadata));

    const response = await GET(new NextRequest("http://localhost/api/teams/team_one/secrets"), {
      params: Promise.resolve({ id: "team_one/other?scope=global" }),
    });

    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/teams/team_one%2Fother%3Fscope%3Dglobal/secrets",
      undefined
    );
    await expect(response.json()).resolves.toEqual(metadata);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("forwards secret writes to the team resource without interpreting values", async () => {
    const body = JSON.stringify({ secrets: { API_TOKEN: "opaque-value" } });
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ success: true }));

    const response = await PUT(
      new NextRequest("http://localhost/api/teams/team_one/secrets", {
        method: "PUT",
        headers: { Cookie: "__Secure-openinspect.session_token=session.signature" },
        body,
      }),
      { params: Promise.resolve({ id: "team_one/other" }) }
    );

    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/teams/team_one%2Fother/secrets", {
      method: "PUT",
      body,
    });
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it.each([401, 403, 404])("preserves upstream GET denial %s", async (status) => {
    const denial = { error: "Denied", reason_code: "not_member" };
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json(denial, { status }));

    const response = await GET(new NextRequest("http://localhost/api/teams/team_one/secrets"), {
      params: Promise.resolve({ id: "team_one" }),
    });

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual(denial);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(controlPlaneUserFetch).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 404])("preserves upstream PUT denial %s", async (status) => {
    const denial = { error: "Denied", reason_code: "not_owner_or_lead" };
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json(denial, { status }));

    const response = await PUT(
      new NextRequest("http://localhost/api/teams/team_one/secrets", {
        method: "PUT",
        headers: { Cookie: "__Secure-openinspect.session_token=session.signature" },
        body: JSON.stringify({ secrets: { API_TOKEN: "opaque-value" } }),
      }),
      { params: Promise.resolve({ id: "team_one" }) }
    );

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual(denial);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(controlPlaneUserFetch).toHaveBeenCalledOnce();
  });

  it("rejects writes without a browser session cookie", async () => {
    const response = await PUT(
      new NextRequest("http://localhost/api/teams/team_one/secrets", {
        method: "PUT",
        body: JSON.stringify({ secrets: { API_TOKEN: "opaque-value" } }),
      }),
      { params: Promise.resolve({ id: "team_one" }) }
    );

    expect(response.status).toBe(401);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });
});
