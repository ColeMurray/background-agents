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

  it("proxies successful media URL responses with no-store caching", async () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "user-1" },
    } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValue(
      Response.json({
        url: "https://media.example.com/artifact.png",
        expiresAt: 1234,
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
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      url: "https://media.example.com/artifact.png",
      expiresAt: 1234,
    });
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
    await expect(response.json()).resolves.toEqual({ error: "Failed to fetch media URL" });
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
    await expect(response.json()).resolves.toEqual({ error: "Failed to fetch media URL" });
  });
});
