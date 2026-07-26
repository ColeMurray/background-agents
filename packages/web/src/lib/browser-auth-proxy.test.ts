import { sha256Hex, verifyServiceSignature } from "@open-inspect/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatchControlPlaneFetch: vi.fn(),
}));

vi.mock("./control-plane-transport", () => ({
  dispatchControlPlaneFetch: mocks.dispatchControlPlaneFetch,
  getControlPlaneUrl: () => "https://control-plane.example",
}));

import { proxyBrowserAuthRequest } from "./browser-auth-proxy";

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
