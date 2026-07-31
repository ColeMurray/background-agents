import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server-auth-session", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { PATCH, parseSessionReadStatePatchBody } from "./route";

describe("session read-state BFF", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
  });

  it("accepts only the two named actions", () => {
    expect(
      parseSessionReadStatePatchBody({ action: "acknowledge", observedAttentionId: "message-1" })
    ).toEqual({ action: "acknowledge", observedAttentionId: "message-1" });
    expect(parseSessionReadStatePatchBody({ action: "mark_read" })).toEqual({
      action: "mark_read",
    });
    expect(parseSessionReadStatePatchBody({ action: "mark_read", userId: "user-2" })).toBeNull();
    expect(parseSessionReadStatePatchBody({ action: "acknowledge" })).toBeNull();
  });

  it("forwards the authenticated action without a caller-selected identity", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ sessionId: "session-1", accepted: true, unread: false })
    );
    const request = new Request("http://localhost/api/sessions/session-1/read-state", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "mark_read" }),
    });

    const response = await PATCH(request as never, {
      params: Promise.resolve({ id: "session-1" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/sessions/session-1/read-state", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "mark_read" }),
    });
  });

  it("rejects unauthenticated requests", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue(null);
    const request = new Request("http://localhost/api/sessions/session-1/read-state", {
      method: "PATCH",
      body: JSON.stringify({ action: "mark_read" }),
    });

    const response = await PATCH(request as never, {
      params: Promise.resolve({ id: "session-1" }),
    });

    expect(response.status).toBe(401);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });
});
