import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET, PUT } from "./route";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

const context = { params: Promise.resolve({ id: "team/one" }) };
const grant = {
  id: "grant-1",
  teamId: "team/one",
  kind: "installation",
  repoExternalId: null,
  owner: null,
  name: null,
  createdAt: 1,
};

describe("team repository grants proxy", () => {
  it("encodes team IDs, strips arbitrary filters, and relays the grants list", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ grants: [grant] }));
    const response = await GET(
      new NextRequest("http://localhost/api/teams/one/repository-grants?teamId=other"),
      context
    );
    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/teams/team%2Fone/repository-grants",
      undefined
    );
    await expect(response.json()).resolves.toEqual({ grants: [grant] });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it.each([
    { kind: "installation" },
    { kind: "repository", repoExternalId: 42, owner: "group/subgroup", name: "api" },
  ])("forwards a PUT grant unchanged (%j)", async (body) => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ grant }, { status: 201 }));
    const response = await PUT(
      new NextRequest("http://localhost/api/teams/one/repository-grants", {
        method: "PUT",
        headers: { Cookie: "__Secure-openinspect.session_token=session.signature" },
        body: JSON.stringify(body),
      }),
      context
    );
    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/teams/team%2Fone/repository-grants", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ grant });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it.each([401, 403, 404, 409])(
    "preserves upstream denials and conflict codes (%s)",
    async (status) => {
      const failure = { error: "Denied", code: "grant_conflict" };
      vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json(failure, { status }));
      const response = await GET(
        new NextRequest("http://localhost/api/teams/one/repository-grants"),
        context
      );
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual(failure);
    }
  );

  it("does not read or forward an unauthenticated mutation", async () => {
    const request = new NextRequest("http://localhost/api/teams/one/repository-grants", {
      method: "PUT",
      body: "{malformed",
    });
    const response = await PUT(request, context);
    expect(response.status).toBe(401);
    expect(request.bodyUsed).toBe(false);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });
});
