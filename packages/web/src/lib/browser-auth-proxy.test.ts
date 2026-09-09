import {
  SERVICE_REQUEST_MAX_BODY_BYTES,
  sha256Hex,
  verifyServiceSignature,
} from "@open-inspect/shared/service-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatchControlPlaneFetch: vi.fn(),
}));

vi.mock("./control-plane-transport", () => ({
  dispatchControlPlaneFetch: mocks.dispatchControlPlaneFetch,
  getControlPlaneUrl: () => "https://control-plane.example",
}));

import { dispatchBrowserAuthRequest, proxyBrowserAuthRequest } from "./browser-auth-proxy";

describe("proxyBrowserAuthRequest", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = {
      ...originalEnv,
      SERVICE_AUTH_SECRET: "web-service-secret",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("rejects an oversized browser-auth body before dispatching it", async () => {
    const request = new Request("https://web.example/api/auth/sign-in/social", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(SERVICE_REQUEST_MAX_BODY_BYTES + 1));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await proxyBrowserAuthRequest(request);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "Request body is too large" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Pragma")).toBe("no-cache");
    expect(mocks.dispatchControlPlaneFetch).not.toHaveBeenCalled();
  });

  it("rejects an oversized declared body without reading its stream", async () => {
    const request = new Request("https://web.example/api/auth/sign-in/social", {
      method: "POST",
      headers: { "Content-Length": String(SERVICE_REQUEST_MAX_BODY_BYTES + 1) },
      body: new ReadableStream<Uint8Array>(),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await proxyBrowserAuthRequest(request);

    expect(response.status).toBe(413);
    expect(request.bodyUsed).toBe(false);
    expect(mocks.dispatchControlPlaneFetch).not.toHaveBeenCalled();
  });

  it("forwards the auth request transparently with a fresh web signature", async () => {
    const upstreamHeaders = new Headers({
      Location: "/after-sign-in",
      "Cache-Control": "private",
    });
    upstreamHeaders.append(
      "Set-Cookie",
      "__Secure-openinspect.session_token=session.signature; Path=/; Secure; HttpOnly"
    );
    upstreamHeaders.append(
      "Set-Cookie",
      "__Secure-openinspect.state=; Path=/; Max-Age=0; Secure; HttpOnly"
    );
    mocks.dispatchControlPlaneFetch.mockResolvedValue(
      new Response("redirecting", {
        status: 302,
        headers: upstreamHeaders,
      })
    );
    const body = JSON.stringify({
      provider: "github",
      callbackURL: "/after-sign-in",
      disableRedirect: true,
    });

    const response = await proxyBrowserAuthRequest(
      new Request("https://web.example/api/auth/sign-in/social?return=1", {
        method: "POST",
        headers: {
          Authorization: "Bearer caller-controlled",
          Connection: "keep-alive",
          Cookie: "__Secure-openinspect.state=state-cookie",
          "Content-Type": "application/json",
          Origin: "https://web.example",
          "User-Agent": "Test Browser",
          "X-Forwarded-For": "203.0.113.42",
          "X-OpenInspect-Client-IP": "198.51.100.99",
          "X-OpenInspect-Service": "modal",
          "X-OpenInspect-Service-Signature": "caller-controlled",
        },
        body,
      })
    );

    const [url, init] = mocks.dispatchControlPlaneFetch.mock.calls[0] ?? [];
    expect(url).toBe("https://control-plane.example/api/auth/sign-in/social?return=1");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
      cache: "no-store",
    });
    expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe(body);

    const sentHeaders = new Headers(init?.headers);
    expect(sentHeaders.get("Cookie")).toBe("__Secure-openinspect.state=state-cookie");
    expect(sentHeaders.get("Content-Type")).toBe("application/json");
    expect(sentHeaders.get("Origin")).toBe("https://web.example");
    expect(sentHeaders.get("User-Agent")).toBe("Test Browser");
    expect(sentHeaders.get("X-OpenInspect-Client-IP")).toBeNull();
    expect(sentHeaders.get("Authorization")).toBeNull();
    expect(sentHeaders.get("Connection")).toBeNull();
    expect(sentHeaders.get("X-OpenInspect-Service")).toBe("web");
    expect(sentHeaders.get("X-OpenInspect-Service-Signature")).toMatch(/^sig1\./);

    const verification = await verifyServiceSignature({
      signatureHeader: sentHeaders.get("X-OpenInspect-Service-Signature") ?? "",
      service: "web",
      secret: "web-service-secret",
      method: "POST",
      url: String(url),
      bodySha256Hex: await sha256Hex(body),
      actor: "",
    });
    expect(verification.ok).toBe(true);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/after-sign-in");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.getSetCookie()).toHaveLength(2);
    expect(await response.text()).toBe("redirecting");
  });

  it("dispatches server-side auth calls without requiring a synthetic request origin", async () => {
    mocks.dispatchControlPlaneFetch.mockResolvedValue(Response.json({ user: { id: "user-1" } }));

    const response = await dispatchBrowserAuthRequest({
      method: "GET",
      pathname: "/api/auth/get-session",
      headers: {
        Cookie: "__Secure-openinspect.session_token=session.signature",
        "X-Trace-Id": "trace-1",
      },
    });

    const [url, init, metadata] = mocks.dispatchControlPlaneFetch.mock.calls[0] ?? [];
    expect(url).toBe("https://control-plane.example/api/auth/get-session");
    expect(init).toMatchObject({
      method: "GET",
      redirect: "manual",
      cache: "no-store",
    });
    expect(metadata).toEqual({});

    const sentHeaders = new Headers(init?.headers);
    expect(sentHeaders.get("Cookie")).toBe("__Secure-openinspect.session_token=session.signature");
    expect(sentHeaders.get("X-Trace-Id")).toBe("trace-1");
    expect(sentHeaders.get("X-OpenInspect-Service")).toBe("web");

    const verification = await verifyServiceSignature({
      signatureHeader: sentHeaders.get("X-OpenInspect-Service-Signature") ?? "",
      service: "web",
      secret: "web-service-secret",
      method: "GET",
      url: String(url),
      bodySha256Hex: await sha256Hex(""),
      actor: "",
    });
    expect(verification.ok).toBe(true);
    expect(response.status).toBe(200);
  });

  it("rejects typed dispatches outside the positive proxy allowlist", async () => {
    const response = await dispatchBrowserAuthRequest({
      method: "GET",
      pathname: "/api/auth/list-sessions",
    });

    expect(response.status).toBe(404);
    expect(mocks.dispatchControlPlaneFetch).not.toHaveBeenCalled();
  });

  it("forwards Vercel's trusted client IP header on Vercel", async () => {
    process.env.VERCEL = "1";
    mocks.dispatchControlPlaneFetch.mockResolvedValue(Response.json({ ok: true }));

    await proxyBrowserAuthRequest(
      new Request("https://web.example/api/auth/get-session", {
        headers: {
          "X-Vercel-Forwarded-For": "203.0.113.42",
          "X-Forwarded-For": "192.0.2.55",
        },
      })
    );

    const [, init] = mocks.dispatchControlPlaneFetch.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("X-OpenInspect-Client-IP")).toBe("203.0.113.42");
  });

  it("forwards Cloudflare's trusted client IP header on Cloudflare", async () => {
    mocks.dispatchControlPlaneFetch.mockResolvedValue(Response.json({ ok: true }));
    const request = new Request("https://web.example/api/auth/get-session", {
      headers: {
        "CF-Connecting-IP": "198.51.100.24",
        "X-Forwarded-For": "192.0.2.55",
      },
    });
    Object.defineProperty(request, "cf", { value: {} });

    await proxyBrowserAuthRequest(request);

    const [, init] = mocks.dispatchControlPlaneFetch.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("X-OpenInspect-Client-IP")).toBe("198.51.100.24");
  });

  it("rejects endpoints outside the positive proxy allowlist", async () => {
    const response = await proxyBrowserAuthRequest(
      new Request("https://web.example/api/auth/list-sessions", {
        method: "GET",
      })
    );

    expect(response.status).toBe(404);
    expect(mocks.dispatchControlPlaneFetch).not.toHaveBeenCalled();
  });

  it("does not advertise upstream compression after fetch decodes the response body", async () => {
    mocks.dispatchControlPlaneFetch.mockResolvedValue(
      new Response(JSON.stringify({ url: "https://github.example/authorize" }), {
        status: 200,
        headers: {
          "Content-Encoding": "br",
          "Content-Length": "999",
          "Content-Type": "application/json",
        },
      })
    );

    const response = await proxyBrowserAuthRequest(
      new Request("https://web.example/api/auth/sign-in/social", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: "github",
          callbackURL: "/",
          disableRedirect: true,
        }),
      })
    );

    expect(response.headers.get("Content-Encoding")).toBeNull();
    expect(response.headers.get("Content-Length")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      url: "https://github.example/authorize",
    });
  });

  it("fails closed when the web signing secret is unavailable", async () => {
    delete process.env.SERVICE_AUTH_SECRET;

    await expect(
      proxyBrowserAuthRequest(
        new Request("https://web.example/api/auth/get-session", {
          method: "GET",
        })
      )
    ).rejects.toThrow("SERVICE_AUTH_SECRET not configured");
    expect(mocks.dispatchControlPlaneFetch).not.toHaveBeenCalled();
  });
});
