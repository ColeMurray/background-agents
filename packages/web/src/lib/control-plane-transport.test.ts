import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

import { headers } from "next/headers";
import { controlPlaneServiceFetch } from "./control-plane-transport";

describe("controlPlaneServiceFetch", () => {
  const originalEnv = { ...process.env };
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = {
      ...originalEnv,
      CONTROL_PLANE_URL: "https://control-plane.example",
      SERVICE_AUTH_SECRET: "web-service-secret",
      NODE_ENV: "development",
    };
    vi.mocked(headers).mockResolvedValue(new Headers({}));
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it("signs with web's sig1 credential and never the legacy bearer", async () => {
    await controlPlaneServiceFetch("/auth/tokens/exchange", {
      method: "POST",
      body: JSON.stringify({ subjectTokenType: "github-access-token", subjectToken: "t" }),
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const sentHeaders = new Headers(init?.headers);
    expect(url).toBe("https://control-plane.example/auth/tokens/exchange");
    expect(sentHeaders.get("X-OpenInspect-Service")).toBe("web");
    expect(sentHeaders.get("X-OpenInspect-Service-Signature")).toMatch(/^sig1\./);
    expect(sentHeaders.get("Authorization")).toBeNull();
  });

  it("throws when SERVICE_AUTH_SECRET is not configured", async () => {
    delete process.env.SERVICE_AUTH_SECRET;
    await expect(
      controlPlaneServiceFetch("/auth/tokens/refresh", { method: "POST", body: "{}" })
    ).rejects.toThrow("SERVICE_AUTH_SECRET not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
