import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn(),
  cookies: vi.fn(),
}));

vi.mock("next-auth/jwt", () => ({
  getToken: vi.fn(),
}));

import { headers, cookies } from "next/headers";
import { getToken } from "next-auth/jwt";
import { controlPlaneUserFetch } from "./control-plane";

describe("controlPlaneUserFetch correlation", () => {
  const originalEnv = { ...process.env };
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = {
      ...originalEnv,
      CONTROL_PLANE_URL: "https://control-plane.example",
      SERVICE_AUTH_SECRET: "web-sig1-secret",
      NODE_ENV: "development",
    };
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    vi.mocked(cookies).mockResolvedValue({
      getAll: () => [{ name: "next-auth.session-token", value: "cookie-value" }],
    } as never);
    vi.mocked(getToken).mockResolvedValue({
      oiAccessToken: "oi_at_live_token",
      oiAccessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
    } as never);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it("propagates the current request trace id downstream", async () => {
    vi.mocked(headers).mockResolvedValue(
      new Headers({
        "x-trace-id": "trace-123",
        "x-request-id": "client-hop-1",
        "x-open-inspect-request-id": "webhop01",
      })
    );

    await controlPlaneUserFetch("/sessions", {
      method: "POST",
      headers: { Range: "bytes=0-5" },
      body: JSON.stringify({ ok: true }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const forwardedHeaders = new Headers(init?.headers);

    expect(url).toBe("https://control-plane.example/sessions");
    expect(forwardedHeaders.get("x-trace-id")).toBe("trace-123");
    expect(forwardedHeaders.get("x-request-id")).toBeNull();
    expect(forwardedHeaders.get("Range")).toBe("bytes=0-5");
    expect(forwardedHeaders.get("Authorization")).toBe("Bearer oi_at_live_token");
    expect(forwardedHeaders.get("X-OpenInspect-Service")).toBeNull();
  });

  it("merges tuple and Headers option headers without dropping values", async () => {
    vi.mocked(headers).mockResolvedValue(
      new Headers({
        "x-trace-id": "trace-123",
        "x-open-inspect-request-id": "webhop01",
      })
    );

    await controlPlaneUserFetch("/sessions", {
      headers: new Headers({ Accept: "application/json" }),
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const forwardedHeaders = new Headers(init?.headers);

    expect(forwardedHeaders.get("Accept")).toBe("application/json");
    expect(forwardedHeaders.get("Content-Type")).toBe("application/json");
    expect(forwardedHeaders.get("x-trace-id")).toBe("trace-123");
  });

  it("generates a fresh trace id when the inbound one is invalid", async () => {
    vi.mocked(headers).mockResolvedValue(
      new Headers({
        "x-trace-id": "not a valid trace id",
        "x-request-id": "client-hop-1",
      })
    );

    await controlPlaneUserFetch("/sessions");

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const traceId = new Headers(init?.headers).get("x-trace-id");

    expect(traceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(traceId).not.toBe("not a valid trace id");
  });

  it("attaches the web session token as the Bearer credential when live", async () => {
    vi.mocked(headers).mockResolvedValue(new Headers({}));
    vi.mocked(cookies).mockResolvedValue({
      getAll: () => [{ name: "next-auth.session-token", value: "cookie-value" }],
    } as never);
    vi.mocked(getToken).mockResolvedValue({
      oiAccessToken: "oi_at_live_token",
      oiAccessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
    } as never);

    await controlPlaneUserFetch("/sessions");

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const forwardedHeaders = new Headers(init?.headers);
    expect(forwardedHeaders.get("Authorization")).toBe("Bearer oi_at_live_token");
  });

  it("never lets a caller-supplied Authorization header override the credential", async () => {
    vi.mocked(headers).mockResolvedValue(new Headers({}));
    vi.mocked(cookies).mockResolvedValue({
      getAll: () => [{ name: "next-auth.session-token", value: "cookie-value" }],
    } as never);
    vi.mocked(getToken).mockResolvedValue({
      oiAccessToken: "oi_at_live_token",
      oiAccessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
    } as never);

    await controlPlaneUserFetch("/sessions", {
      headers: { Authorization: "Bearer caller-supplied" },
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const forwardedHeaders = new Headers(init?.headers);
    expect(forwardedHeaders.get("Authorization")).toBe("Bearer oi_at_live_token");
  });

  it("returns 401 without dispatching when the web session token is expired", async () => {
    vi.mocked(headers).mockResolvedValue(new Headers({}));
    vi.mocked(cookies).mockResolvedValue({
      getAll: () => [{ name: "next-auth.session-token", value: "cookie-value" }],
    } as never);
    vi.mocked(getToken).mockResolvedValue({
      oiAccessToken: "oi_at_expired",
      oiAccessTokenExpiresAt: Date.now() - 1000,
    } as never);

    const response = await controlPlaneUserFetch("/sessions");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not require the web service credential for user-facing calls", async () => {
    delete process.env.SERVICE_AUTH_SECRET;
    vi.mocked(headers).mockResolvedValue(new Headers({}));

    const response = await controlPlaneUserFetch("/sessions");

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer oi_at_live_token");
  });

  it("never falls back to web's sig1 service credential when no web session token is live", async () => {
    process.env.SERVICE_AUTH_SECRET = "web-sig1-secret";
    vi.mocked(headers).mockResolvedValue(new Headers({}));
    vi.mocked(cookies).mockResolvedValue({ getAll: () => [] } as never);
    vi.mocked(getToken).mockResolvedValue(null);

    const body = JSON.stringify({ title: "t" });
    const response = await controlPlaneUserFetch("/sessions/abc/title", { method: "POST", body });

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards the exact bytes of a buffered binary body and keeps the caller Content-Type", async () => {
    vi.mocked(headers).mockResolvedValue(new Headers({}));

    const body = new TextEncoder().encode("--boundary\r\nfake multipart\r\n--boundary--").buffer;
    await controlPlaneUserFetch("/sessions/abc/attachments", {
      method: "POST",
      body,
      headers: { "Content-Type": "multipart/form-data; boundary=boundary" },
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const forwardedHeaders = new Headers(init?.headers);
    expect(forwardedHeaders.get("Content-Type")).toBe("multipart/form-data; boundary=boundary");
    expect(forwardedHeaders.get("Authorization")).toBe("Bearer oi_at_live_token");
    expect(init?.body).toBe(body);
  });
});
