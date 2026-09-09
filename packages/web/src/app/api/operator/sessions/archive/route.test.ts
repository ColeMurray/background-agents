import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server-auth-session", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

import { controlPlaneUserFetch } from "@/lib/control-plane";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { POST } from "./route";

describe("operator session archive BFF", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
  });

  it("rejects unauthenticated requests", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue(null);
    const response = await POST(
      new Request("http://localhost/api/operator/sessions/archive", {
        method: "POST",
        body: JSON.stringify({}),
      }) as never
    );

    expect(response.status).toBe(401);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("forwards the body and preserves the control-plane status and response", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "Operator access required" }, { status: 403 })
    );
    const body = { cursor: "100:50:session-1" };
    const response = await POST(
      new Request("http://localhost/api/operator/sessions/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }) as never
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: "Operator access required" });
    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/operator/sessions/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  });
});
