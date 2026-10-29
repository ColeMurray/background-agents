import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server-auth-session", () => ({
  getServerAuthSession: vi.fn(),
}));

vi.mock("@/lib/control-plane", () => ({
  controlPlaneUserFetch: vi.fn(),
}));

import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { WEB_SESSION_ATTACHMENT_MAX_REQUEST_BYTES } from "@/lib/session-attachment-limits";
import { POST } from "./route";

function streamingUploadRequest(size: number): NextRequest {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(size));
      controller.close();
    },
  });
  return new NextRequest("http://localhost/api/sessions/session-1/attachments", {
    method: "POST",
    headers: {
      "Content-Type": "multipart/form-data; boundary=test",
      Cookie: "openinspect.session_token=test-session",
    },
    body,
    duplex: "half",
  });
}

describe("session attachment API route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each(["", "unrelated=value; openinspect.oauth_state=state"])(
    "rejects uploads without a session cookie before reading the body (cookies: %s)",
    async (cookie) => {
      const request = new NextRequest("http://localhost/api/sessions/session-1/attachments", {
        method: "POST",
        headers: { "Content-Type": "multipart/form-data; boundary=test", Cookie: cookie },
        body: "ignored",
      });
      const readBody = vi.spyOn(request, "body", "get");

      const response = await POST(request, { params: Promise.resolve({ id: "session-1" }) });

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
      expect(readBody).not.toHaveBeenCalled();
      expect(getServerAuthSession).not.toHaveBeenCalled();
      expect(controlPlaneUserFetch).not.toHaveBeenCalled();
    }
  );

  it("delegates invalid session cookies to the control plane", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "Unauthorized" }, { status: 401 })
    );

    const response = await POST(streamingUploadRequest(1), {
      params: Promise.resolve({ id: "session-1" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(getServerAuthSession).not.toHaveBeenCalled();
    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/sessions/session-1/attachments", {
      method: "POST",
      body: new Uint8Array(1).buffer,
      headers: { "Content-Type": "multipart/form-data; boundary=test" },
    });
  });

  it("rejects multipart requests above the portable web limit before proxying", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/sessions/session-1/attachments", {
        method: "POST",
        headers: {
          "Content-Type": "multipart/form-data; boundary=test",
          "Content-Length": String(WEB_SESSION_ATTACHMENT_MAX_REQUEST_BYTES + 1),
          Cookie: "openinspect.session_token=test-session",
        },
        body: "oversized",
      }),
      { params: Promise.resolve({ id: "session-1" }) }
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "Attachment is too large" });
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("bounds streamed requests when Content-Length is unavailable", async () => {
    const response = await POST(
      streamingUploadRequest(WEB_SESSION_ATTACHMENT_MAX_REQUEST_BYTES + 1),
      { params: Promise.resolve({ id: "session-1" }) }
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "Attachment is too large" });
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });
});
