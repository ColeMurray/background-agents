import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server-auth-session", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { POST } from "./route";

describe("session external action decision BFF", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
  });

  it("forwards the decision to the control plane", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ ok: true }));
    const response = await POST(
      new Request("http://local/api/sessions/session-1/external-actions/action-1/decision", {
        method: "POST",
        body: JSON.stringify({ decision: "approve" }),
      }) as never,
      { params: Promise.resolve({ id: "session-1", actionId: "action-1" }) }
    );

    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/sessions/session-1/external-actions/action-1/decision",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ decision: "approve" }) })
    );
    expect(response.status).toBe(200);
  });

  it("rejects unauthenticated decisions before control-plane access", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue(null);
    const response = await POST(
      new Request("http://local/api/sessions/session-1/external-actions/action-1/decision", {
        method: "POST",
        body: JSON.stringify({ decision: "approve" }),
      }) as never,
      { params: Promise.resolve({ id: "session-1", actionId: "action-1" }) }
    );

    expect(response.status).toBe(401);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });
});
