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
import { WEB_SESSION_ATTACHMENT_MAX_REQUEST_BYTES } from "@/lib/session-attachment-limits";
import { POST } from "./route";

function streamingUploadRequest(size: number): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(size));
      controller.close();
    },
  });
  return new Request("http://localhost/api/sessions/session-1/attachments", {
    method: "POST",
    headers: { "Content-Type": "multipart/form-data; boundary=test" },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("session attachment API route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "user-1" } } as never);
  });

  it("rejects unauthenticated uploads before reading the body", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);

    const response = await POST(
      new Request("http://localhost/api/sessions/session-1/attachments", {
        method: "POST",
        headers: { "Content-Type": "multipart/form-data; boundary=test" },
        body: "ignored",
      }),
      { params: Promise.resolve({ id: "session-1" }) }
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("rejects multipart requests above the portable web limit before proxying", async () => {
    const response = await POST(
      new Request("http://localhost/api/sessions/session-1/attachments", {
        method: "POST",
        headers: {
          "Content-Type": "multipart/form-data; boundary=test",
          "Content-Length": String(WEB_SESSION_ATTACHMENT_MAX_REQUEST_BYTES + 1),
        },
        body: "oversized",
      }),
      { params: Promise.resolve({ id: "session-1" }) }
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "Attachment is too large" });
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });

  it("bounds streamed requests when Content-Length is unavailable", async () => {
    const response = await POST(
      streamingUploadRequest(WEB_SESSION_ATTACHMENT_MAX_REQUEST_BYTES + 1),
      { params: Promise.resolve({ id: "session-1" }) }
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "Attachment is too large" });
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });
});
