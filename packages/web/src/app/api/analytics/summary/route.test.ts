import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/control-plane", () => ({
  controlPlaneUserFetch: vi.fn(),
}));

import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET } from "./route";

describe("analytics summary API route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("delegates authentication to the resource request", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "Unauthorized" }, { status: 401 })
    );

    const response = await GET(
      new Request("http://localhost/api/analytics/summary?days=14") as never
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(controlPlaneUserFetch).toHaveBeenCalledTimes(1);
  });

  it("forwards only the allowed summary query params", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ totalSessions: 5 }, { status: 200 })
    );

    const response = await GET(
      new Request("http://localhost/api/analytics/summary?debug=true&days=14") as never
    );

    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/analytics/summary?days=14");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ totalSessions: 5 });
  });

  it("returns 500 when the control plane request throws", async () => {
    vi.mocked(controlPlaneUserFetch).mockRejectedValue(new Error("boom"));

    const response = await GET(new Request("http://localhost/api/analytics/summary") as never);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Failed to fetch analytics summary" });
  });
});
