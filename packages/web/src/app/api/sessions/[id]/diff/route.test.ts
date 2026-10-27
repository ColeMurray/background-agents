import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server-auth-session", () => ({
  getServerAuthSession: vi.fn(),
}));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET } from "./route";

describe("session diff API route", () => {
  beforeEach(() => vi.resetAllMocks());

  it("relays a control-plane 401 without a separate session lookup", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "Unauthorized" }, { status: 401 })
    );
    const context = { params: Promise.resolve({ id: "session-1" }) };

    const response = await GET(new Request("http://local/api/sessions/session-1/diff"), context);

    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(getServerAuthSession).not.toHaveBeenCalled();
  });

  it("proxies the latest manifest with private caching", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValueOnce(
      Response.json({ version: 1, current: null, lastError: null, unavailableReason: null })
    );
    const context = { params: Promise.resolve({ id: "session-1" }) };

    const manifest = await GET(new Request("http://local/api/sessions/session-1/diff"), context);
    expect(controlPlaneUserFetch).toHaveBeenNthCalledWith(1, "/sessions/session-1/diff");
    expect(manifest.headers.get("Cache-Control")).toBe("private, no-store");
    expect(manifest.headers.get("Vary")).toBe("Cookie");
  });
});
