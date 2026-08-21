import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/control-plane", () => ({
  controlPlaneUserFetch: vi.fn(),
}));

import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET } from "./route";

describe("analytics timeseries API route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("passes through an upstream unauthorized response", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "Unauthorized" }, { status: 401 })
    );

    const response = await GET(
      new Request("http://localhost/api/analytics/timeseries?days=30") as never
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("forwards only the days query param", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ series: [] }, { status: 200 })
    );

    const response = await GET(
      new Request("http://localhost/api/analytics/timeseries?trace=1&view=status&days=7") as never
    );

    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/analytics/timeseries?days=7");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ series: [] });
  });

  it("passes through upstream error statuses", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "Bad request" }, { status: 400 })
    );

    const response = await GET(
      new Request("http://localhost/api/analytics/timeseries?days=14") as never
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Bad request" });
  });
});
