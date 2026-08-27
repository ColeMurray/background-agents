import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/control-plane", () => ({
  controlPlaneUserFetch: vi.fn(),
}));

import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET } from "./route";

describe("pull request analytics API route", () => {
  beforeEach(() => vi.resetAllMocks());

  it("forwards only the days query parameter", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ pullRequests: [] }, { status: 200 })
    );

    const response = await GET(
      new Request("http://localhost/api/analytics/pull-requests?days=30&debug=true") as never
    );

    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/analytics/pull-requests?days=30");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ pullRequests: [] });
  });
});
