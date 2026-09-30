import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET } from "./route";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

describe("GET team sessions proxy", () => {
  it.each([401, 403, 404])(
    "preserves upstream %s before interpreting an invalid bucket or body",
    async (status) => {
      vi.mocked(controlPlaneUserFetch).mockResolvedValue(new Response("not JSON", { status }));
      const response = await GET(
        new NextRequest(
          "http://localhost/api/teams/team_one/sessions?bucket=invalid&cursor=invalid"
        ),
        { params: Promise.resolve({ id: "team_one" }) }
      );
      expect(controlPlaneUserFetch).toHaveBeenCalledOnce();
      expect(response.status).toBe(status);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
  );

  it("relays a standard inbox bucket page unchanged", async () => {
    const page = { items: [], hasMore: true, nextCursor: "opaque/+cursor" };
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json(page));
    const response = await GET(
      new NextRequest("http://localhost/api/teams/team_one/sessions?bucket=in_progress"),
      { params: Promise.resolve({ id: "team_one" }) }
    );
    await expect(response.json()).resolves.toEqual(page);
  });

  it("forwards bucket and opaque cursor without widening or interpreting server access", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "Forbidden" }, { status: 403 })
    );
    const response = await GET(
      new NextRequest(
        "http://localhost/api/teams/team_one/sessions?bucket=needs_attention&cursor=opaque%2Fcursor&teamId=other"
      ),
      { params: Promise.resolve({ id: "team_one" }) }
    );
    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/teams/team_one/sessions?bucket=needs_attention&cursor=opaque%2Fcursor",
      undefined
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
