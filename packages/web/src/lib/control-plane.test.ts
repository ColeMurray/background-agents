import { sha256Hex, verifyServiceSignature } from "@open-inspect/shared/service-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn(),
  cookies: vi.fn(),
}));

import { cookies, headers } from "next/headers";
import { controlPlaneUserFetch } from "./control-plane";

describe("controlPlaneUserFetch", () => {
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
    vi.mocked(headers).mockResolvedValue(
      new Headers({
        "x-trace-id": "trace-123",
        "x-request-id": "client-hop-1",
        "x-open-inspect-request-id": "webhop01",
      })
    );
    vi.mocked(cookies).mockResolvedValue({
      getAll: () => [
        { name: "__Secure-openinspect.session_token", value: "session.signature" },
        { name: "__Secure-openinspect.state", value: "oauth-state" },
        { name: "unrelated", value: "do-not-forward" },
      ],
    } as never);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it("combines the browser session with a fresh web signature", async () => {
    const body = JSON.stringify({ ok: true });
    await controlPlaneUserFetch("/sessions?archived=false", {
      method: "POST",
      headers: {
        Authorization: "Bearer caller-controlled",
        Cookie: "caller=controlled",
        Range: "bytes=0-5",
        "X-OpenInspect-Service": "modal",
        "X-OpenInspect-Service-Signature": "caller-controlled",
      },
      body,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const sentHeaders = new Headers(init?.headers);

    expect(url).toBe("https://control-plane.example/sessions?archived=false");
    expect(sentHeaders.get("Cookie")).toBe("__Secure-openinspect.session_token=session.signature");
    expect(sentHeaders.get("Authorization")).toBeNull();
    expect(sentHeaders.get("Range")).toBe("bytes=0-5");
    expect(sentHeaders.get("x-trace-id")).toBe("trace-123");
    expect(sentHeaders.get("x-request-id")).toBeNull();
    expect(sentHeaders.get("X-OpenInspect-Service")).toBe("web");
    expect(sentHeaders.get("X-OpenInspect-Service-Signature")).toMatch(/^sig1\./);

    const verification = await verifyServiceSignature({
      signatureHeader: sentHeaders.get("X-OpenInspect-Service-Signature") ?? "",
      service: "web",
      secret: "web-sig1-secret",
      method: "POST",
      url: String(url),
      bodySha256Hex: await sha256Hex(body),
      actor: "",
    });
    expect(verification.ok).toBe(true);
  });

  it("merges Headers options without dropping caller values", async () => {
    await controlPlaneUserFetch("/sessions", {
      headers: new Headers({ Accept: "application/json" }),
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const sentHeaders = new Headers(init?.headers);

    expect(sentHeaders.get("Accept")).toBe("application/json");
    expect(sentHeaders.get("Content-Type")).toBe("application/json");
    expect(sentHeaders.get("x-trace-id")).toBe("trace-123");
  });

  it("preserves caller cancellation while enforcing the transport timeout", async () => {
    const caller = new AbortController();

    await controlPlaneUserFetch("/sessions", { signal: caller.signal });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal).not.toBe(caller.signal);
    expect(init?.signal?.aborted).toBe(false);

    caller.abort("caller disconnected");

    expect(init?.signal?.aborted).toBe(true);
    expect(init?.signal?.reason).toBe("caller disconnected");
  });

  it("preserves caller redirect and cache policy", async () => {
    await controlPlaneUserFetch("/sessions", {
      redirect: "error",
      cache: "force-cache",
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.redirect).toBe("error");
    expect(init?.cache).toBe("force-cache");
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

    expect(traceId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(traceId).not.toBe("not a valid trace id");
  });

  it("returns 401 without dispatching when the browser session cookie is absent", async () => {
    vi.mocked(cookies).mockResolvedValue({
      getAll: () => [{ name: "__Secure-openinspect.state", value: "oauth-state" }],
    } as never);

    const response = await controlPlaneUserFetch("/sessions");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when the web signing secret is unavailable", async () => {
    delete process.env.SERVICE_AUTH_SECRET;

    await expect(controlPlaneUserFetch("/sessions")).rejects.toThrow(
      "SERVICE_AUTH_SECRET not configured"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards the exact bytes of a buffered binary body", async () => {
    const body = new TextEncoder().encode("--boundary\r\nbinary\u0000body\r\n--boundary--").buffer;
    await controlPlaneUserFetch("/sessions/abc/attachments", {
      method: "POST",
      body,
      headers: { "Content-Type": "multipart/form-data; boundary=boundary" },
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const sentHeaders = new Headers(init?.headers);
    expect(sentHeaders.get("Content-Type")).toBe("multipart/form-data; boundary=boundary");
    expect(init?.body).toBe(body);

    const verification = await verifyServiceSignature({
      signatureHeader: sentHeaders.get("X-OpenInspect-Service-Signature") ?? "",
      service: "web",
      secret: "web-sig1-secret",
      method: "POST",
      url: String(url),
      bodySha256Hex: await sha256Hex(body),
      actor: "",
    });
    expect(verification.ok).toBe(true);
  });

  it("rejects body types whose exact dispatched bytes cannot be signed", async () => {
    await expect(
      controlPlaneUserFetch("/sessions", {
        method: "POST",
        body: new URLSearchParams({ title: "hello" }),
      })
    ).rejects.toThrow("Unsupported control-plane request body");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
