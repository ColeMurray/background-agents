import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.mock("@/lib/control-plane", () => ({
  controlPlaneFetch: vi.fn(),
}));

import { getServerSession } from "next-auth";
import { controlPlaneFetch } from "@/lib/control-plane";
import { POST } from "./route";

describe("session prompt API route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "user-1" } } as never);
  });

  it("rejects malformed attachment references before proxying", async () => {
    const response = await POST(
      new Request("http://localhost/api/sessions/session-1/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "Look",
          attachments: [{ name: "remote.png", url: "https://example.com/image.png" }],
        }),
      }) as never,
      { params: Promise.resolve({ id: "session-1" }) }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid prompt request" });
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("proxies validated attachment references", async () => {
    vi.mocked(controlPlaneFetch).mockResolvedValue(
      Response.json({ messageId: "message-1", status: "queued" })
    );

    const response = await POST(
      new Request("http://localhost/api/sessions/session-1/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "Look",
          attachments: [{ name: "shot.png", uploadId: "upload-1" }],
        }),
      }) as never,
      { params: Promise.resolve({ id: "session-1" }) }
    );

    expect(response.status).toBe(200);
    expect(controlPlaneFetch).toHaveBeenCalledWith("/sessions/session-1/prompt", {
      method: "POST",
      body: expect.any(String),
    });
    const requestBody = vi.mocked(controlPlaneFetch).mock.calls[0][1]?.body;
    expect(JSON.parse(requestBody as string)).toEqual({
      content: "Look",
      authorId: "user-1",
      source: "web",
      attachments: [{ name: "shot.png", uploadId: "upload-1" }],
    });
  });
});
