import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { controlPlaneUserFetch } from "./control-plane";
import { SETTINGS_PROXY_MAX_BODY_BYTES, settingsProxy } from "./settings-proxy";

vi.mock("./control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

function streamingMutationRequest(size: number, cookie?: string): NextRequest {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(size));
      controller.close();
    },
  });
  return new NextRequest("http://localhost/api/settings", {
    method: "POST",
    headers: cookie ? { Cookie: cookie } : undefined,
    body,
    duplex: "half",
  } as never);
}

describe("settingsProxy", () => {
  const { GET, POST } = settingsProxy(() => "/settings", "settings");

  beforeEach(() => vi.resetAllMocks());

  it("delegates authentication to the resource request", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "Unauthorized" }, { status: 401 })
    );

    const response = await GET(new NextRequest("http://localhost/api/settings"), {
      params: Promise.resolve(undefined),
    });

    expect(controlPlaneUserFetch).toHaveBeenCalledTimes(1);
    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/settings", undefined);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("delegates authentication before malformed mutation JSON is interpreted", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "Unauthorized" }, { status: 401 })
    );
    const request = new NextRequest("http://localhost/api/settings", {
      method: "POST",
      headers: { Cookie: "__Secure-openinspect.session_token=session.signature" },
      body: "{malformed",
    });

    const response = await POST(request, { params: Promise.resolve(undefined) });

    const options = vi.mocked(controlPlaneUserFetch).mock.calls[0]?.[1];
    expect(options?.method).toBe("POST");
    expect(options?.body).toBe("{malformed");
    expect(response.status).toBe(401);
  });

  it("rejects a missing session cookie before reading an oversized body", async () => {
    const request = streamingMutationRequest(SETTINGS_PROXY_MAX_BODY_BYTES + 1);

    const response = await POST(request, { params: Promise.resolve(undefined) });

    expect(response.status).toBe(401);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
  });

  it("caps oversized bodies carrying an unverified session cookie", async () => {
    const response = await POST(
      streamingMutationRequest(
        SETTINGS_PROXY_MAX_BODY_BYTES + 1,
        "__Secure-openinspect.session_token=forged.invalid-session"
      ),
      { params: Promise.resolve(undefined) }
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "Request body is too large" });
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("keeps resource request failures distinct from unauthorized responses", async () => {
    vi.mocked(controlPlaneUserFetch).mockRejectedValue(new Error("authentication unavailable"));

    const response = await GET(new NextRequest("http://localhost/api/settings"), {
      params: Promise.resolve(undefined),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Failed to fetch settings" });
  });
});
