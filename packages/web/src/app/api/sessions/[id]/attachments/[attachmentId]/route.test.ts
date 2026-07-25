import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server-auth-session", () => ({
  getServerAuthSession: vi.fn(),
}));

vi.mock("@/lib/control-plane", () => ({
  controlPlaneUserFetch: vi.fn(),
}));

import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET } from "./route";

const PARAMS = {
  params: Promise.resolve({ id: "session-1", attachmentId: "attachment-1" }),
};

describe("session attachment download API route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
  });

  it("rejects unauthenticated downloads before contacting the control plane", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue(null);

    const response = await GET(
      new Request("http://localhost/api/sessions/session-1/attachments/attachment-1"),
      PARAMS
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("forwards byte ranges and preserves storage response headers", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      new Response("bytes", {
        status: 206,
        headers: {
          "Content-Type": "image/png",
          "Content-Length": "5",
          "Content-Range": "bytes 0-4/10",
          "Accept-Ranges": "bytes",
          ETag: '"etag-1"',
        },
      })
    );

    const response = await GET(
      new Request("http://localhost/api/sessions/session-1/attachments/attachment-1", {
        headers: { Range: "bytes=0-4" },
      }),
      PARAMS
    );

    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/sessions/session-1/attachments/attachment-1",
      {
        headers: { Range: "bytes=0-4" },
      }
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 0-4/10");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
