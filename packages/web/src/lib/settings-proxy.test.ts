import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { controlPlaneUserFetch } from "./control-plane";
import { settingsProxy } from "./settings-proxy";

vi.mock("./control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

describe("settingsProxy", () => {
  const { GET, POST } = settingsProxy(() => "/settings", "settings");

  beforeEach(() => vi.resetAllMocks());

  it("delegates authentication to the resource request", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "Unauthorized" }, { status: 401 })
    );

    const response = await GET(new NextRequest("http://localhost/api/settings"), {
      params: Promise.resolve(undefined),
    });

    expect(controlPlaneUserFetch).toHaveBeenCalledTimes(1);
    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/settings", undefined);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("delegates authentication before malformed mutation JSON is interpreted", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "Unauthorized" }, { status: 401 })
    );
    const request = new NextRequest("http://localhost/api/settings", {
      method: "POST",
      body: "{malformed",
    });

    const response = await POST(request, { params: Promise.resolve(undefined) });

    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/settings", {
      method: "POST",
      body: "{malformed",
    });
    expect(response.status).toBe(401);
  });

  it("keeps resource request failures distinct from unauthorized responses", async () => {
    vi.mocked(controlPlaneUserFetch).mockRejectedValue(new Error("authentication unavailable"));

    const response = await GET(new NextRequest("http://localhost/api/settings"), {
      params: Promise.resolve(undefined),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Failed to fetch settings" });
  });
});
