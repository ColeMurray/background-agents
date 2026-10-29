import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

import { controlPlaneUserFetch } from "@/lib/control-plane";
import { POST } from "./route";

const context = { params: Promise.resolve({ id: "auto-1" }) };

function request(body?: BodyInit, headers: HeadersInit = {}): NextRequest {
  return new NextRequest("http://localhost/api/automations/auto-1/regenerate-key", {
    method: "POST",
    headers: { Cookie: "openinspect.session_token=test-session", ...headers },
    body,
    duplex: "half",
  });
}

describe("automation key regeneration body limit", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ webhookApiKey: "new-key" }));
  });

  it("forwards an empty request without adding a body", async () => {
    const response = await POST(request(), context);

    expect(response.status).toBe(200);
    expect(controlPlaneUserFetch).toHaveBeenCalledWith("/automations/auto-1/regenerate-key", {
      method: "POST",
    });
  });

  it.each([JSON.stringify({ sentryClientSecret: "secret-\u00e9" }), "{malformed"])(
    "forwards within-limit text unchanged: %s",
    async (body) => {
      const response = await POST(request(body), context);

      expect(response.status).toBe(200);
      expect(controlPlaneUserFetch).toHaveBeenCalledWith("/automations/auto-1/regenerate-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
    }
  );

  it("preserves delegated authentication for within-limit requests", async () => {
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(
      Response.json({ error: "Unauthorized" }, { status: 401 })
    );

    const response = await POST(request("{}"), context);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("rejects an oversized Content-Length without reading or proxying the body", async () => {
    const upload = request("ignored", { "Content-Length": "1000000" });
    const readBody = vi.spyOn(upload, "body", "get");

    const response = await POST(upload, context);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "Request body too large" });
    expect(readBody).not.toHaveBeenCalled();
    expect(upload.bodyUsed).toBe(false);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it.each([
    "__Secure-openinspect.session_token=invalid-session",
    "openinspect.session_token=invalid-session",
  ])("caps and cancels streamed bodies before proxying (cookies: %s)", async (cookie) => {
    let chunksRead = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(4096));
        if (++chunksRead === 10) controller.close();
      },
      cancel,
    });
    const upload = request(body, cookie ? { Cookie: cookie, "Content-Length": "1" } : {});

    const response = await POST(upload, context);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "Request body too large" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(chunksRead).toBeLessThan(10);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });
});
