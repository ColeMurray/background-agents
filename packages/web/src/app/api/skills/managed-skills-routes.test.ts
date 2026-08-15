import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { DELETE, PUT } from "./[id]/route";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));
vi.mock("@/lib/server-auth-session", () => ({ getServerAuthSession: vi.fn() }));

describe("managed skills BFF routes", () => {
  beforeEach(() => vi.resetAllMocks());

  it("rejects unauthenticated aggregate updates", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue(null);
    const request = new NextRequest("http://localhost/api/skills/skill-1", {
      method: "PUT",
      body: JSON.stringify({ description: "A skill", body: "Use it" }),
    });

    const response = await PUT(request, { params: Promise.resolve({ id: "skill-1" }) });

    expect(response.status).toBe(401);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("forwards the aggregate edit and revision precondition", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ skill: { id: "skill/one" } }, { status: 200 })
    );
    const body = {
      content: { description: "A skill", body: "Use it", files: [] },
      assignments: [],
    };
    const request = new NextRequest("http://localhost/api/skills/skill%2Fone", {
      method: "PUT",
      headers: { "If-Match": "revision-3" },
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
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
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
