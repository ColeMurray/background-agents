import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshXaiToken, XaiTokenRefreshError, type XaiTokenResponse } from "./xai";

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
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(tokens)),
    } as Response);

    await expect(refreshXaiToken("refresh-old")).resolves.toEqual(tokens);

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toBe("https://auth.x.ai/oauth2/token");
    expect(String(init?.body)).toContain("grant_type=refresh_token");
    expect(String(init?.body)).toContain("refresh_token=refresh-old");
    expect(String(init?.body)).toContain("client_id=b1a00492-073a-47ea-816f-4c329264a828");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("accepts responses without a replacement refresh token", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{"access_token":"access-new"}'),
    } as Response);

    await expect(refreshXaiToken("refresh-old")).resolves.toEqual({
      access_token: "access-new",
    });
  });

  it("accepts a rotated refresh token without expires_in", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{"access_token":"access-new","refresh_token":"refresh-new"}'),
    } as Response);

    await expect(refreshXaiToken("refresh-old")).resolves.toEqual({
      access_token: "access-new",
      refresh_token: "refresh-new",
    });
  });

  it("classifies invalid_grant refresh errors", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('{"error":"invalid_grant"}'),
    } as Response);

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
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(body),
    } as Response);

    await expect(refreshXaiToken("refresh")).rejects.toBeInstanceOf(XaiTokenRefreshError);
  });

  it("accepts provider lifetimes longer than one day", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{"access_token":"access","expires_in":172800}'),
    } as Response);

    await expect(refreshXaiToken("refresh")).resolves.toMatchObject({ expires_in: 172_800 });
  });
});
