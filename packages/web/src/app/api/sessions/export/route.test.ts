import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server-auth-session", () => ({ getServerAuthSession: vi.fn() }));
vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET } from "./route";

describe("bulk session export proxy", () => {
  beforeEach(() => vi.resetAllMocks());

  it("requires a browser session before contacting the control plane", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue(null);

    const response = await GET(new Request("http://local/api/sessions/export"));

    expect(response.status).toBe(401);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("streams NDJSON and forwards only the supported bulk query parameters", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    const body = new ReadableStream<Uint8Array>();
    vi.mocked(controlPlaneUserFetch).mockResolvedValueOnce(
      new Response(body, { headers: { "Content-Type": "application/x-ndjson" } })
    );
    const request = new Request(
      "http://local/api/sessions/export?scope=runs&include=events&format=compact&limit=5&cursor=abc&createdAfter=100&createdBefore=200&unsafe=secret"
    );

    const response = await GET(request);

    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/sessions/export?scope=runs&include=events&format=compact&limit=5&cursor=abc&createdAfter=100&createdBefore=200",
      { signal: request.signal },
      { streamResponse: true }
    );
    expect(response.body).toBe(body);
    expect(response.headers.get("Content-Type")).toBe("application/x-ndjson");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
  });

  it("preserves upstream authorization errors", async () => {
    vi.mocked(getServerAuthSession).mockResolvedValue({ user: { id: "user-1" } } as never);
    vi.mocked(controlPlaneUserFetch).mockResolvedValueOnce(
      Response.json({ error: "Forbidden" }, { status: 403 })
    );

    const response = await GET(new Request("http://local/api/sessions/export"));

    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
  });
});
