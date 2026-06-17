import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.mock("@/lib/control-plane", () => ({
  controlPlaneFetch: vi.fn(),
}));

import { getServerSession } from "next-auth";
import { controlPlaneFetch } from "@/lib/control-plane";
import { GET } from "./route";

describe("session file artifact API route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 401 when the user session is missing", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);

    const response = await GET(new Request("http://localhost/api/sessions/session-1/files/a1"), {
      params: Promise.resolve({
        id: "session-1",
        artifactId: "artifact-1",
      }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("rejects invalid IDs before proxying to the control plane", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1" },
    } as never);

    const response = await GET(new Request("http://localhost/api/sessions/session-1/files/bad"), {
      params: Promise.resolve({
        id: "session-1",
        artifactId: "../../admin",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid artifact ID" });
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("proxies downloadable files with filename headers", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1" },
    } as never);
    const upstreamBody = new TextEncoder().encode("zip bytes");
    vi.mocked(controlPlaneFetch).mockResolvedValue(
      new Response(upstreamBody, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Length": String(upstreamBody.byteLength),
          "Content-Disposition": 'attachment; filename="review_packet.zip"',
          ETag: '"file-etag"',
        },
      })
    );

    const response = await GET(new Request("http://localhost/api/sessions/session-1/files/a1"), {
      params: Promise.resolve({
        id: "session-1",
        artifactId: "artifact-1",
      }),
    });

    expect(controlPlaneFetch).toHaveBeenCalledWith("/sessions/session-1/files/artifact-1");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
    expect(response.headers.get("Content-Type")).toBe("application/zip");
    expect(response.headers.get("Content-Length")).toBe(String(upstreamBody.byteLength));
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="review_packet.zip"'
    );
    expect(response.headers.get("ETag")).toBe('"file-etag"');
    expect(await response.text()).toBe("zip bytes");
  });

  it("passes through upstream error statuses", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1" },
    } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValue(new Response("not found", { status: 404 }));

    const response = await GET(new Request("http://localhost/api/sessions/session-1/files/a1"), {
      params: Promise.resolve({
        id: "session-1",
        artifactId: "artifact-1",
      }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Failed to fetch file artifact" });
  });
});
