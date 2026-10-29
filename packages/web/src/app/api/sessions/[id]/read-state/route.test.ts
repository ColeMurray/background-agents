import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server-auth-session", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { PATCH } from "./route";

describe("session read-state BFF", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects actions outside the shared request contract", async () => {
    const request = new NextRequest("http://localhost/api/sessions/session-1/read-state", {
      method: "PATCH",
      headers: { Cookie: "openinspect.session_token=test-session" },
      body: JSON.stringify({ action: "mark_latest_message_read", userId: "user-2" }),
    });

    const response = await PATCH(request as never, {
      params: Promise.resolve({ id: "session-1" }),
    });

    expect(response.status).toBe(400);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("forwards the authenticated action without a caller-selected identity", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({
        sessionId: "session-1",
        outcome: "no_terminal_message",
        unread: false,
        latestMessageId: null,
        version: 0,
      })
    );
    const request = new NextRequest("http://localhost/api/sessions/session-1/read-state", {
      method: "PATCH",
      headers: {
        Cookie: "openinspect.session_token=test-session",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "mark_latest_message_read" }),
    });

    const response = await PATCH(request as never, {
      params: Promise.resolve({ id: "session-1" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/sessions/session-1/read-state", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "mark_latest_message_read" }),
    });
  });

  it("relays a control-plane 401 without a separate session lookup", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "Unauthorized" }, { status: 401 })
    );
    const request = new NextRequest("http://localhost/api/sessions/session-1/read-state", {
      method: "PATCH",
      headers: { Cookie: "openinspect.session_token=test-session" },
      body: JSON.stringify({ action: "mark_latest_message_read" }),
    });

    const response = await PATCH(request as never, {
      params: Promise.resolve({ id: "session-1" }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(getServerAuthSession).not.toHaveBeenCalled();
  });
});
