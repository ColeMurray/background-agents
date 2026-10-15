import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server-auth-session", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { POST } from "./route";

function markReadRequest(body: unknown) {
  return new Request("http://localhost/api/sessions/inbox/read-state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("session inbox read-state BFF", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
  });

  it("forwards the inbox filters to the control plane", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ markedCount: 3 }));

    const response = await POST(markReadRequest({ mine: true, teamIds: ["team_a"] }) as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ markedCount: 3 });
    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/sessions/inbox/read-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mine: true, teamIds: ["team_a"] }),
    });
  });

  it("rejects bodies outside the shared request contract", async () => {
    const response = await POST(markReadRequest({ userId: "user-2" }) as never);

    expect(response.status).toBe(400);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue(null);

    const response = await POST(markReadRequest({}) as never);

    expect(response.status).toBe(401);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });
});
