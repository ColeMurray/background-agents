import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server-auth-session", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { PATCH } from "./route";

describe("session read-state BFF", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
  });

  it("rejects actions outside the shared request contract", async () => {
    const request = new Request("http://localhost/api/sessions/session-1/read-state", {
      method: "PATCH",
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
      })
    );
    const request = new Request("http://localhost/api/sessions/session-1/read-state", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
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

  it("rejects unauthenticated requests", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue(null);
    const request = new Request("http://localhost/api/sessions/session-1/read-state", {
      method: "PATCH",
      body: JSON.stringify({ action: "mark_latest_message_read" }),
    });

    const response = await PATCH(request as never, {
      params: Promise.resolve({ id: "session-1" }),
    });

    expect(response.status).toBe(401);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });
});
