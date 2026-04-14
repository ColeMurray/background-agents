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

describe("analytics breakdown API route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 401 when the user session is missing", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);

    const response = await GET(
      new Request("http://localhost/api/analytics/breakdown?days=30&by=user") as never
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("forwards only days and by query params", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValue(Response.json({ entries: [] }, { status: 200 }));

    const response = await GET(
      new Request("http://localhost/api/analytics/breakdown?days=90&foo=bar&by=repo") as never
    );

    expect(controlPlaneFetch).toHaveBeenCalledWith("/analytics/breakdown?days=90&by=repo");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ entries: [] });
  });

  it("returns 500 when the control plane request throws", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(controlPlaneFetch).mockRejectedValue(new Error("boom"));

    const response = await GET(new Request("http://localhost/api/analytics/breakdown") as never);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to fetch analytics breakdown",
    });
  });
});
