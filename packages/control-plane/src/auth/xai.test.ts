import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkXaiDeviceAuthorization,
  fetchXaiAccountId,
  refreshXaiToken,
  startXaiDeviceAuthorization,
  XaiTokenRefreshError,
  type XaiTokenResponse,
} from "./xai";

describe("refreshXaiToken", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("uses the pinned Grok CLI OAuth client", async () => {
    const tokens: XaiTokenResponse = {
      access_token: "access-new",
      refresh_token: "refresh-new",
      expires_in: 3600,
    };
    globalThis.fetch = vi.fn().mockResolvedValue(Response.json(tokens));

    await expect(refreshXaiToken("refresh-old")).resolves.toEqual(tokens);

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toBe("https://auth.x.ai/oauth2/token");
    expect(String(init?.body)).toContain("grant_type=refresh_token");
    expect(String(init?.body)).toContain("refresh_token=refresh-old");
    expect(String(init?.body)).toContain("client_id=b1a00492-073a-47ea-816f-4c329264a828");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("accepts responses without a replacement refresh token", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(Response.json({ access_token: "access-new" }));

    await expect(refreshXaiToken("refresh-old")).resolves.toEqual({
      access_token: "access-new",
    });
  });

  it("accepts a rotated refresh token without expires_in", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ access_token: "access-new", refresh_token: "refresh-new" })
      );

    await expect(refreshXaiToken("refresh-old")).resolves.toEqual({
      access_token: "access-new",
      refresh_token: "refresh-new",
    });
  });

  it("classifies invalid_grant refresh errors", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ error: "invalid_grant" }, { status: 401 }));

    const error = await refreshXaiToken("stale").catch((cause) => cause);
    expect(error).toBeInstanceOf(XaiTokenRefreshError);
    expect(error).toMatchObject({ status: 401, reason: "invalid_grant" });
    expect(error).not.toHaveProperty("body");
  });

  it.each([
    '{"access_token":""}',
    '{"access_token":"access","expires_in":0}',
    '{"access_token":"access","expires_in":1.5}',
  ])("rejects unusable successful responses: %s", async (body) => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(body));

    await expect(refreshXaiToken("refresh")).rejects.toBeInstanceOf(XaiTokenRefreshError);
  });

  it("accepts provider lifetimes longer than one day", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ access_token: "access", expires_in: 172_800 }));

    await expect(refreshXaiToken("refresh")).resolves.toMatchObject({ expires_in: 172_800 });
  });
});

describe("xAI device authorization", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("starts with the Grok CLI client and uses the complete verification URL", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      Response.json({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://accounts.x.ai/oauth2/device",
        verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH",
        expires_in: 300,
        interval: 5,
      })
    );

    await expect(startXaiDeviceAuthorization()).resolves.toEqual({
      deviceCode: "device-secret",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH",
      expiresInMs: 300_000,
      intervalMs: 5_000,
    });
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toBe("https://auth.x.ai/oauth2/device/code");
    expect(new URLSearchParams(String(init?.body))).toEqual(
      new URLSearchParams({
        client_id: "b1a00492-073a-47ea-816f-4c329264a828",
        scope: "openid profile email offline_access grok-cli:access api:access",
        referrer: "opencode",
      })
    );
  });

  it.each([
    ["authorization_pending", { status: "pending" }],
    ["slow_down", { status: "pending", intervalMs: 10_000 }],
    ["access_denied", { status: "denied" }],
    ["authorization_denied", { status: "denied" }],
    ["expired_token", { status: "expired" }],
    ["invalid_grant", { status: "failed" }],
  ])("maps %s token responses", async (error, expected) => {
    globalThis.fetch = vi.fn().mockResolvedValue(Response.json({ error }, { status: 400 }));

    await expect(checkXaiDeviceAuthorization("device-secret", 5_000)).resolves.toEqual(expected);
  });

  it("exchanges a device code without exposing it in the result state", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      Response.json({
        id_token: makeJwt({ sub: "xai-user" }),
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
      })
    );

    await expect(checkXaiDeviceAuthorization("device-secret", 5_000)).resolves.toMatchObject({
      status: "connected",
      tokens: { access_token: "access", refresh_token: "refresh" },
    });
    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(new URLSearchParams(String(init?.body))).toEqual(
      new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: "b1a00492-073a-47ea-816f-4c329264a828",
        device_code: "device-secret",
      })
    );
  });

  it("fetches the stable OIDC subject from xAI", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(Response.json({ sub: "xai-user" }));

    await expect(fetchXaiAccountId("access-secret")).resolves.toBe("xai-user");
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toBe("https://auth.x.ai/oauth2/userinfo");
    expect(init?.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer access-secret",
    });
  });

  it("uses the canonical bounded provider-response path", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("x", {
        headers: { "Content-Length": String(64 * 1024 + 1) },
      })
    );

    await expect(startXaiDeviceAuthorization()).rejects.toThrow("oversized response");
  });
});

function makeJwt(payload: Record<string, unknown>): string {
  return `${btoa(JSON.stringify({ alg: "none" }))}.${btoa(JSON.stringify(payload))}.`;
}
