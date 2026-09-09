import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET } from "./route";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

describe("GET /api/audit-events", () => {
  beforeEach(() => vi.resetAllMocks());

  it("forwards only limit and cursor query parameters", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ events: [], hasMore: false, nextCursor: null })
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/audit-events?limit=25&cursor=opaque%2Fcursor&filter=denied&limit=10"
      ),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(200);
    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/audit-events?limit=25&limit=10&cursor=opaque%2Fcursor",
      undefined
    );
  });
});
