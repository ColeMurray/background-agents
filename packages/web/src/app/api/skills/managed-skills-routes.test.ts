import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { DELETE, PUT } from "./[id]/route";
import { GET } from "./route";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

describe("managed skills BFF routes", () => {
  beforeEach(() => vi.resetAllMocks());

  it("propagates unauthenticated aggregate updates from the control plane", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "Unauthorized" }, { status: 401 })
    );
    const request = new NextRequest("http://localhost/api/skills/skill-1", {
      method: "PUT",
      headers: { Cookie: "__Secure-openinspect.session_token=session.signature" },
      body: JSON.stringify({ description: "A skill", body: "Use it" }),
    });

    const response = await PUT(request, { params: Promise.resolve({ id: "skill-1" }) });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(controlPlaneUserFetch).toHaveBeenCalledTimes(1);
  });

  it("forwards catalog pagination parameters", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ skills: [], hasMore: false, nextCursor: null })
    );
    const request = new NextRequest(
      "http://localhost/api/skills?limit=50&cursor=first-skill&ignored=value"
    );

    const response = await GET(request, { params: Promise.resolve(undefined) });

    expect(response.status).toBe(200);
    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/skills?limit=50&cursor=first-skill",
      undefined
    );
  });

  it("forwards the aggregate edit and revision precondition", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ skill: { id: "skill/one" } }, { status: 200 })
    );
    const body = {
      content: { description: "A skill", body: "Use it", files: [] },
      assignments: [],
    };
    const request = new NextRequest("http://localhost/api/skills/skill%2Fone", {
      method: "PUT",
      headers: {
        Cookie: "__Secure-openinspect.session_token=session.signature",
        "If-Match": "revision-3",
      },
      body: JSON.stringify(body),
    });

    const response = await PUT(request, { params: Promise.resolve({ id: "skill/one" }) });

    expect(response.status).toBe(200);
    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/skills/skill%2Fone", {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "If-Match": "revision-3" },
    });
  });

  it("forwards empty control-plane responses without synthesizing a JSON body", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(new Response(null, { status: 204 }));
    const request = new NextRequest("http://localhost/api/skills/skill-1", {
      method: "DELETE",
    });

    const response = await DELETE(request, { params: Promise.resolve({ id: "skill-1" }) });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/skills/skill-1", {
      method: "DELETE",
    });
  });
});
