import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/control-plane", () => ({ controlPlaneFetch: vi.fn() }));

import { getServerSession } from "next-auth";
import { controlPlaneFetch } from "@/lib/control-plane";
import { GET } from "./route";

describe("session diff API route", () => {
  beforeEach(() => vi.resetAllMocks());

  it("requires authentication", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    const context = { params: Promise.resolve({ id: "session-1" }) };

    expect(
      (await GET(new Request("http://local/api/sessions/session-1/diff"), context)).status
    ).toBe(401);
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("proxies the latest manifest with private caching", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(controlPlaneFetch).mockResolvedValueOnce(
      Response.json({ version: 1, current: null, lastError: null, unavailableReason: null })
    );
    const context = { params: Promise.resolve({ id: "session-1" }) };

    const manifest = await GET(new Request("http://local/api/sessions/session-1/diff"), context);
    expect(controlPlaneFetch).toHaveBeenNthCalledWith(1, "/sessions/session-1/diff");
    expect(manifest.headers.get("Cache-Control")).toBe("private, no-store");
    expect(manifest.headers.get("Vary")).toBe("Cookie");
  });
});
