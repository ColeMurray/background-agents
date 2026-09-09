import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/control-plane", () => ({
  controlPlaneUserFetch: vi.fn(),
}));

import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET } from "./route";

describe("analytics dashboard API route", () => {
  beforeEach(() => vi.resetAllMocks());

  it("forwards one authenticated dashboard request and decodes its response", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ generatedAt: 123, window: { days: 14, startAt: 1, endAt: 2 } })
    );

    const response = await GET(
      new Request("http://localhost/api/analytics/dashboard?debug=true&days=14") as never
    );

    expect(controlPlaneUserFetch).toHaveBeenCalledTimes(1);
    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/analytics/dashboard?days=14");
    await expect(response.json()).resolves.toEqual({
      generatedAt: 123,
      window: { days: 14, startAt: 1, endAt: 2 },
    });
  });

  it("returns a stable failure response when the control plane request throws", async () => {
    vi.mocked(controlPlaneUserFetch).mockRejectedValue(new Error("boom"));

    const response = await GET(
      new Request("http://localhost/api/analytics/dashboard?days=30") as never
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to fetch analytics dashboard",
    });
  });
});
