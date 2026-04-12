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

describe("session media API route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 401 when the user session is missing", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);

    const response = await GET(new Request("http://localhost/api/sessions/session-1/media/a1"), {
      params: Promise.resolve({
        id: "session-1",
        artifactId: "artifact-1",
      }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("rejects invalid artifact IDs before proxying to the control plane", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1" },
    } as never);

    const response = await GET(new Request("http://localhost/api/sessions/session-1/media/bad"), {
      params: Promise.resolve({
        id: "session-1",
        artifactId: "../../admin",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid artifact ID" });
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("rejects invalid session IDs before proxying to the control plane", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1" },
    } as never);

    const response = await GET(new Request("http://localhost/api/sessions/bad/media/a1"), {
      params: Promise.resolve({
        id: "../admin",
        artifactId: "artifact-1",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid session ID" });
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("proxies successful media streams with private no-store caching", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1" },
    } as never);
    const upstreamBody = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    vi.mocked(controlPlaneFetch).mockResolvedValue(
      new Response(upstreamBody, {
        headers: {
          "Content-Type": "image/png",
          "Content-Length": String(upstreamBody.byteLength),
          ETag: '"artifact-etag"',
        },
      })
    );

    const response = await GET(new Request("http://localhost/api/sessions/session-1/media/a1"), {
      params: Promise.resolve({
        id: "session-1",
        artifactId: "artifact-1",
      }),
    });

    expect(controlPlaneFetch).toHaveBeenCalledWith("/sessions/session-1/media/artifact-1");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Content-Length")).toBe(String(upstreamBody.byteLength));
    expect(response.headers.get("ETag")).toBe('"artifact-etag"');
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(
      Array.from(upstreamBody)
    );
  });

  it("passes through upstream error statuses", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1" },
    } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValue(
      new Response("not found", {
        status: 404,
      })
    );

    const response = await GET(new Request("http://localhost/api/sessions/session-1/media/a1"), {
      params: Promise.resolve({
        id: "session-1",
        artifactId: "artifact-1",
      }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Failed to fetch media" });
  });

  it("returns 500 when the control plane request throws", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1" },
    } as never);
    vi.mocked(controlPlaneFetch).mockRejectedValue(new Error("boom"));

    const response = await GET(new Request("http://localhost/api/sessions/session-1/media/a1"), {
      params: Promise.resolve({
        id: "session-1",
        artifactId: "artifact-1",
      }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Failed to fetch media" });
  });
});
