import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server-auth-session", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET } from "./route";

describe("session external actions BFF", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
  });

  it("proxies the pending list with private caching", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ actions: [], nextCursor: null })
    );
    const response = await GET(
      new Request("http://local/api/sessions/session-1/external-actions?limit=10") as never,
      { params: Promise.resolve({ id: "session-1" }) }
    );

    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/sessions/session-1/external-actions?limit=10"
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("rejects unauthenticated discovery before control-plane access", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue(null);
    const response = await GET(
      new Request("http://local/api/sessions/session-1/external-actions") as never,
      { params: Promise.resolve({ id: "session-1" }) }
    );

    expect(response.status).toBe(401);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });
});
