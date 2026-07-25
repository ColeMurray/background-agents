import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server-auth-session", () => ({
  getServerAuthSession: vi.fn(),
}));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { POST } from "./route";

describe("session diff retry API route", () => {
  beforeEach(() => vi.resetAllMocks());

  it("requires authentication", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue(null);
    const response = await POST(new Request("http://local"), {
      params: Promise.resolve({ id: "session-1" }),
    });

    expect(response.status).toBe(401);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("proxies retry responses and preserves the upstream explanation", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "Sandbox is not connected" }, { status: 409 })
    );

    const response = await POST(new Request("http://local"), {
      params: Promise.resolve({ id: "session-1" }),
    });

    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/sessions/session-1/diff/retry", {
      method: "POST",
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Sandbox is not connected" });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
