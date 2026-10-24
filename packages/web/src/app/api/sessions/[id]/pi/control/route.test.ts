import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));
vi.mock("@/lib/browser-session-cookie", () => ({
  serializeBrowserSessionCookies: vi.fn(() => "session=value"),
}));

import { controlPlaneUserFetch } from "@/lib/control-plane";
import { POST } from "./route";

describe("Pi control BFF", () => {
  beforeEach(() => vi.resetAllMocks());

  it("forwards explicit controls and browser authentication", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ requestId: "request-1", state: "accepted" }, { status: 202 })
    );
    const request = new NextRequest("http://local/api/sessions/session-1/pi/control", {
      method: "POST",
      headers: { cookie: "session=value", "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "follow_up",
        requestId: "request-1",
        conversationId: 1,
        content: "focus on tests",
      }),
    });
    const response = await POST(request, { params: Promise.resolve({ id: "session-1" }) });
    expect(response.status).toBe(202);
    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/sessions/session-1/pi/control",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"action":"follow_up"'),
      })
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
