import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn(),
  cookies: vi.fn(),
}));

vi.mock("next-auth/jwt", () => ({
  getToken: vi.fn(),
}));

import { sha256Hex, verifyServiceSignature } from "@open-inspect/shared";
import { headers, cookies } from "next/headers";
import { getToken } from "next-auth/jwt";
import { controlPlaneFetch } from "./control-plane";

describe("controlPlaneFetch correlation", () => {
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

    await controlPlaneFetch("/sessions", {
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
    expect(forwardedHeaders.get("Authorization")).toBeNull();
    expect(forwardedHeaders.get("X-OpenInspect-Service")).toBe("web");
  });

  it("merges tuple and Headers option headers without dropping values", async () => {
    vi.mocked(headers).mockResolvedValue(
      new Headers({
        "x-trace-id": "trace-123",
        "x-open-inspect-request-id": "webhop01",
      })
    );

    await controlPlaneFetch("/sessions", {
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

    await controlPlaneFetch("/sessions");

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

    await controlPlaneFetch("/sessions");

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

    await controlPlaneFetch("/sessions", {
      headers: { Authorization: "Bearer caller-supplied" },
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const forwardedHeaders = new Headers(init?.headers);
    expect(forwardedHeaders.get("Authorization")).toBe("Bearer oi_at_live_token");
  });

  it("signs with the sig1 service credential when the web session token is expired", async () => {
    vi.mocked(headers).mockResolvedValue(new Headers({}));
    vi.mocked(cookies).mockResolvedValue({
      getAll: () => [{ name: "next-auth.session-token", value: "cookie-value" }],
    } as never);
    vi.mocked(getToken).mockResolvedValue({
      oiAccessToken: "oi_at_expired",
      oiAccessTokenExpiresAt: Date.now() - 1000,
    } as never);

    await controlPlaneFetch("/sessions");

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const forwardedHeaders = new Headers(init?.headers);
    expect(forwardedHeaders.get("Authorization")).toBeNull();
    expect(forwardedHeaders.get("X-OpenInspect-Service")).toBe("web");
  });

  it("throws when SERVICE_AUTH_SECRET is not configured and no token is live", async () => {
    delete process.env.SERVICE_AUTH_SECRET;
    vi.mocked(headers).mockResolvedValue(new Headers({}));
    vi.mocked(cookies).mockResolvedValue({ getAll: () => [] } as never);

    await expect(controlPlaneFetch("/sessions")).rejects.toThrow(
      /Control plane credentials not configured/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("signs with web's sig1 service credential when no web session token is live", async () => {
    process.env.SERVICE_AUTH_SECRET = "web-sig1-secret";
    vi.mocked(headers).mockResolvedValue(new Headers({}));
    vi.mocked(cookies).mockResolvedValue({ getAll: () => [] } as never);

    const body = JSON.stringify({ title: "t" });
    await controlPlaneFetch("/sessions/abc/title", { method: "POST", body });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const forwardedHeaders = new Headers(init?.headers);
    expect(forwardedHeaders.get("Authorization")).toBeNull();
    expect(forwardedHeaders.get("X-OpenInspect-Service")).toBe("web");
    const verified = await verifyServiceSignature({
      signatureHeader: forwardedHeaders.get("X-OpenInspect-Service-Signature")!,
      service: "web",
      secret: "web-sig1-secret",
      method: "POST",
      url: String(url),
      bodySha256Hex: await sha256Hex(body),
      actor: "",
    });
    expect(verified).toMatchObject({ ok: true });
  });

  it("signs the exact bytes of a buffered binary body and keeps the caller Content-Type", async () => {
    process.env.SERVICE_AUTH_SECRET = "web-sig1-secret";
    vi.mocked(headers).mockResolvedValue(new Headers({}));
    vi.mocked(cookies).mockResolvedValue({ getAll: () => [] } as never);

    const body = new TextEncoder().encode("--boundary\r\nfake multipart\r\n--boundary--").buffer;
    await controlPlaneFetch("/sessions/abc/attachments", {
      method: "POST",
      body,
      headers: { "Content-Type": "multipart/form-data; boundary=boundary" },
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const forwardedHeaders = new Headers(init?.headers);
    expect(forwardedHeaders.get("Content-Type")).toBe("multipart/form-data; boundary=boundary");
    const verified = await verifyServiceSignature({
      signatureHeader: forwardedHeaders.get("X-OpenInspect-Service-Signature")!,
      service: "web",
      secret: "web-sig1-secret",
      method: "POST",
      url: String(url),
      bodySha256Hex: await sha256Hex(body),
      actor: "",
    });
    expect(verified).toMatchObject({ ok: true });
  });

  it("rejects bodies whose exact bytes cannot be signed", async () => {
    process.env.SERVICE_AUTH_SECRET = "web-sig1-secret";
    vi.mocked(headers).mockResolvedValue(new Headers({}));
    vi.mocked(cookies).mockResolvedValue({ getAll: () => [] } as never);

    const formData = new FormData();
    formData.append("file", new Blob(["x"]));
    await expect(
      controlPlaneFetch("/sessions", { method: "POST", body: formData })
    ).rejects.toThrow(/string or buffered binary body/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
