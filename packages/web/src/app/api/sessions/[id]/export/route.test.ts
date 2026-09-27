import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server-auth-session", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET } from "./route";

describe("single-session export proxy", () => {
  beforeEach(() => vi.resetAllMocks());

  const context = { params: Promise.resolve({ id: "session-1" }) };

  it("requires a browser session and rejects invalid IDs", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue(null);
    expect(
      (await GET(new Request("http://local/api/sessions/session-1/export"), context)).status
    ).toBe(401);
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    expect(
      (
        await GET(new Request("http://local/api/sessions/%2F/export"), {
          params: Promise.resolve({ id: "/" }),
        })
      ).status
    ).toBe(400);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("streams the upstream trace with an attachment name and forwards safe query options", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    const body = new ReadableStream<Uint8Array>();
    vi.mocked(controlPlaneUserFetch).mockResolvedValueOnce(
      new Response(body, {
        headers: { "Content-Type": "application/x-ndjson" },
      })
    );
    const response = await GET(
      new Request("http://local/api/sessions/session-1/export?include=events&format=compact"),
      context
    );
    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/sessions/session-1/export?include=events&format=compact",
      { signal: expect.any(AbortSignal) },
      { streamResponse: true }
    );
    expect(response.body).toBe(body);
    expect(response.headers.get("Content-Type")).toBe("application/x-ndjson");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="session-session-1.ndjson"'
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("preserves upstream permission and validation failures without downloading them", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(controlPlaneUserFetch).mockResolvedValueOnce(
      Response.json({ error: "Forbidden" }, { status: 403 })
    );
    const response = await GET(new Request("http://local/api/sessions/session-1/export"), context);
    expect(response.status).toBe(403);
    expect(response.headers.get("Content-Disposition")).toBeNull();
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
  });
});
