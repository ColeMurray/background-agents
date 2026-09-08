import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyBrowserAuthRequest: vi.fn(),
}));

vi.mock("@/lib/browser-auth-proxy", () => ({
  proxyBrowserAuthRequest: mocks.proxyBrowserAuthRequest,
}));

import { GET, POST } from "./route";

describe("/api/auth/*", () => {
  it.each([
    ["GET", GET],
    ["POST", POST],
  ] as const)("passes %s requests to the positive browser-auth proxy", async (_method, handler) => {
    const upstream = new Response("proxied", { status: 202 });
    mocks.proxyBrowserAuthRequest.mockResolvedValueOnce(upstream);
    const request = new Request("https://app.example/api/auth/get-session", {
      method: _method,
    });

    await expect(handler(request)).resolves.toBe(upstream);
    expect(mocks.proxyBrowserAuthRequest).toHaveBeenCalledWith(request);
  });
});
