import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { verifySubjectToken } from "./subject-verification";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFetchResponse(status: number, body: unknown): void {
  vi.mocked(globalThis.fetch).mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  );
}

describe("github-access-token", () => {
  it("returns the provider-verified identity", async () => {
    mockFetchResponse(200, {
      id: 583231,
      login: "octocat",
      name: "The Octocat",
      email: null,
      avatar_url: "https://avatars.example/octocat",
    });
    const result = await verifySubjectToken("github-access-token", "gho_token");
    expect(result).toEqual({
      ok: true,
      subject: {
        provider: "github",
        providerUserId: "583231",
        providerLogin: "octocat",
        providerEmail: undefined,
        displayName: "The Octocat",
        avatarUrl: "https://avatars.example/octocat",
      },
    });
    expect(vi.mocked(globalThis.fetch).mock.calls[0][0]).toBe("https://api.github.com/user");
  });

  it("maps provider 401 to subject_rejected", async () => {
    mockFetchResponse(401, { message: "Bad credentials" });
    expect(await verifySubjectToken("github-access-token", "bad")).toEqual({
      ok: false,
      failure: "subject_rejected",
    });
  });

  it("maps provider 5xx and network failures to provider_unavailable", async () => {
    mockFetchResponse(502, {});
    expect(await verifySubjectToken("github-access-token", "t")).toEqual({
      ok: false,
      failure: "provider_unavailable",
    });
    vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError("network down"));
    expect(await verifySubjectToken("github-access-token", "t")).toEqual({
      ok: false,
      failure: "provider_unavailable",
    });
  });
});

describe("google-access-token", () => {
  it("returns the provider-verified identity from userinfo", async () => {
    mockFetchResponse(200, {
      sub: "1078462347",
      email: "person@example.com",
      email_verified: true,
      name: "A Person",
      picture: "https://lh3.example/photo",
    });
    const result = await verifySubjectToken("google-access-token", "ya29.token");
    expect(result).toEqual({
      ok: true,
      subject: {
        provider: "google",
        providerUserId: "1078462347",
        providerEmail: "person@example.com",
        displayName: "A Person",
        avatarUrl: "https://lh3.example/photo",
      },
    });
    expect(String(vi.mocked(globalThis.fetch).mock.calls[0][0])).toBe(
      "https://openidconnect.googleapis.com/v1/userinfo"
    );
  });

  it("maps provider 401 to subject_rejected", async () => {
    mockFetchResponse(401, { error: "invalid_token" });
    expect(await verifySubjectToken("google-access-token", "bad")).toEqual({
      ok: false,
      failure: "subject_rejected",
    });
  });

  it("treats malformed userinfo responses as provider_unavailable", async () => {
    mockFetchResponse(200, { not_sub: "x" });
    expect(await verifySubjectToken("google-access-token", "t")).toEqual({
      ok: false,
      failure: "provider_unavailable",
    });
  });

  it("maps network failures to provider_unavailable", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError("network down"));
    expect(await verifySubjectToken("google-access-token", "t")).toEqual({
      ok: false,
      failure: "provider_unavailable",
    });
  });
});
