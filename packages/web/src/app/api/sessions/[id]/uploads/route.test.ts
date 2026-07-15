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
import { WEB_PROMPT_UPLOAD_MAX_REQUEST_BYTES } from "@/lib/prompt-attachment-limits";
import { POST } from "./route";

describe("session upload API route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "user-1" } } as never);
  });

  it("rejects multipart requests above the portable web limit before proxying", async () => {
    const response = await POST(
      new Request("http://localhost/api/sessions/session-1/uploads", {
        method: "POST",
        headers: {
          "Content-Type": "multipart/form-data; boundary=test",
          "Content-Length": String(WEB_PROMPT_UPLOAD_MAX_REQUEST_BYTES + 1),
        },
        body: "oversized",
      }),
      { params: Promise.resolve({ id: "session-1" }) }
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "Attachment is too large" });
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });
});
