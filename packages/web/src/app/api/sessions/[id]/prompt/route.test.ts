import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server-auth-session", () => ({
  getServerAuthSession: vi.fn(),
}));

vi.mock("@/lib/control-plane", () => ({
  controlPlaneUserFetch: vi.fn(),
}));

import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { POST } from "./route";

describe("session prompt API route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
  });

  it("rejects blank prompts without attachments before proxying", async () => {
    const response = await POST(
      new Request("http://localhost/api/sessions/session-1/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: " \n" }),
      }) as never,
      { params: Promise.resolve({ id: "session-1" }) }
    );

    expect(response.status).toBe(400);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
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
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("proxies validated attachment references", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ messageId: "message-1", status: "queued" })
    );

    const response = await POST(
      new Request("http://localhost/api/sessions/session-1/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "Look",
          attachments: [{ name: "shot.png", attachmentId: "attachment-1" }],
        }),
      }) as never,
      { params: Promise.resolve({ id: "session-1" }) }
    );

    expect(response.status).toBe(200);
    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/sessions/session-1/prompt", {
      method: "POST",
      body: expect.any(String),
    });
    const requestBody = vi.mocked(controlPlaneUserFetch).mock.calls[0][1]?.body;
    // authorId is forbidden under strict identity enforcement — the control
    // plane derives the author from the Bearer principal.
    expect(JSON.parse(requestBody as string)).toEqual({
      content: "Look",
      source: "web",
      attachments: [{ name: "shot.png", attachmentId: "attachment-1" }],
    });
  });

  it("preserves structured budget-exhausted responses", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json(
        { error: "Session cost limit reached", code: "BUDGET_EXHAUSTED" },
        { status: 409 }
      )
    );

    const response = await POST(
      new Request("http://localhost/api/sessions/session-1/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Continue" }),
      }) as never,
      { params: Promise.resolve({ id: "session-1" }) }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Session cost limit reached",
      code: "BUDGET_EXHAUSTED",
    });
  });

  it("forwards a valid key and preserves the original message ID and conflict code", async () => {
    vi.mocked(controlPlaneUserFetch)
      .mockResolvedValueOnce(Response.json({ messageId: "original", status: "queued" }))
      .mockResolvedValueOnce(
        Response.json({ error: "Conflict", code: "PROMPT_REQUEST_CONFLICT" }, { status: 409 })
      );
    const send = () =>
      POST(
        new Request("http://localhost/api/sessions/s/prompt", {
          method: "POST",
          body: JSON.stringify({ content: "Hi", clientRequestId: "request-1" }),
        }) as never,
        { params: Promise.resolve({ id: "s" }) }
      );
    await expect((await send()).json()).resolves.toEqual({
      messageId: "original",
      status: "queued",
    });
    expect(
      JSON.parse(String(vi.mocked(controlPlaneUserFetch).mock.calls[0][1]?.body))
    ).toMatchObject({
      clientRequestId: "request-1",
    });
    const conflict = await send();
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ code: "PROMPT_REQUEST_CONFLICT" });
  });

  it.each(["", "x".repeat(129), 42])("rejects invalid request key %s", async (clientRequestId) => {
    const response = await POST(
      new Request("http://localhost/api/sessions/s/prompt", {
        method: "POST",
        body: JSON.stringify({ content: "Hi", clientRequestId }),
      }) as never,
      { params: Promise.resolve({ id: "s" }) }
    );
    expect(response.status).toBe(400);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });
});
