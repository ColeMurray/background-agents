import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/control-plane", () => ({
  controlPlaneUserFetch: vi.fn(),
}));

import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET } from "./route";

function request(path: string): NextRequest {
  return { nextUrl: new URL(`http://localhost${path}`) } as NextRequest;
}

describe("session inbox API route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("forwards canonical snapshots and cursor pagination", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ categories: {} }));

    const snapshotResponse = await GET(request("/api/sessions/inbox?mine=true&ignored=true"));
    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/sessions/inbox?mine=true");
    expect(snapshotResponse.status).toBe(200);

    await GET(request("/api/sessions/inbox?category=finished&cursor=next&mine=true&ignored=true"));

    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/sessions/inbox?category=finished&cursor=next&mine=true"
    );
    expect(snapshotResponse.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
