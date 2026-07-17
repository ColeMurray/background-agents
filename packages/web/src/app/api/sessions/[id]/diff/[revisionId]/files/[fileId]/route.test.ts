import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/control-plane", () => ({ controlPlaneFetch: vi.fn() }));

import { getServerSession } from "next-auth";
import { controlPlaneFetch } from "@/lib/control-plane";
import { GET } from "./route";

const context = {
  params: Promise.resolve({ id: "session-1", revisionId: "capture-1", fileId: "file-1" }),
};

describe("session diff file API route", () => {
  beforeEach(() => vi.resetAllMocks());

  it("requires authentication and validates every route identity", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    expect((await GET(new Request("http://local/patch"), context)).status).toBe(401);
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    const invalid = {
      params: Promise.resolve({ id: "../session", revisionId: "capture-1", fileId: "file-1" }),
    };
    expect((await GET(new Request("http://local/patch"), invalid)).status).toBe(400);
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("streams patch text from the revision-pinned control-plane route", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValue(
      new Response("diff --git a/a b/a\n", {
        headers: { "Content-Type": "text/x-diff", ETag: '"patch-1"' },
      })
    );

    const response = await GET(new Request("http://local/patch"), context);
    expect(controlPlaneFetch).toHaveBeenCalledWith(
      "/sessions/session-1/diff/capture-1/files/file-1"
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
    await expect(response.text()).resolves.toContain("diff --git");
  });

  it("preserves the stale-revision payload and status", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValue(
      Response.json(
        { code: "diff_revision_stale", currentRevisionId: "capture-2" },
        { status: 409 }
      )
    );

    const response = await GET(new Request("http://local/patch"), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "diff_revision_stale",
      currentRevisionId: "capture-2",
    });
  });

  it("returns a bounded error when the control plane is unavailable", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(controlPlaneFetch).mockRejectedValue(new Error("offline"));

    const response = await GET(new Request("http://local/patch"), context);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Failed to fetch diff file" });
  });
});
