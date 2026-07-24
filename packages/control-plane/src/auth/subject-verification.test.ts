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

const OCTOCAT = {
  id: 583231,
  login: "octocat",
  name: "The Octocat",
  email: null,
  avatar_url: "https://avatars.example/octocat",
};

/** URL-aware GitHub mock: /user and /user/emails answer independently. */
function mockGitHubFetch(opts: {
  user?: { status?: number; body?: unknown };
  emails?: { status?: number; body?: unknown; reject?: boolean };
}): void {
  vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
    const url = String(input);
    if (url === "https://api.github.com/user") {
      return new Response(JSON.stringify(opts.user?.body ?? OCTOCAT), {
        status: opts.user?.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "https://api.github.com/user/emails") {
      if (opts.emails?.reject) throw new TypeError("network down");
      return new Response(JSON.stringify(opts.emails?.body ?? []), {
        status: opts.emails?.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected url ${url}`);
  });
}

describe("github-access-token", () => {
  it("resolves the verified primary email even when the public profile email is null", async () => {
    mockGitHubFetch({
      emails: {
        body: [
          { email: "secondary@example.com", primary: false, verified: true },
          { email: "primary@example.com", primary: true, verified: true },
        ],
      },
    });
    const result = await verifySubjectToken("github-access-token", "gho_token");
    expect(result).toEqual({
      ok: true,
      subject: {
        provider: "github",
        providerUserId: "583231",
        providerLogin: "octocat",
        // The verified primary from /user/emails, NOT /user.email (null) — so
        // email-based cross-provider linking mints the family on the right user.
        providerEmail: "primary@example.com",
        displayName: "The Octocat",
        avatarUrl: "https://avatars.example/octocat",
      },
    });
    const urls = vi.mocked(globalThis.fetch).mock.calls.map((c) => String(c[0]));
    expect(urls).toEqual(["https://api.github.com/user", "https://api.github.com/user/emails"]);
  });

  it("falls back to no email when /user/emails is forbidden (best-effort, exchange not failed)", async () => {
    mockGitHubFetch({ emails: { status: 403, body: { message: "forbidden" } } });
    expect(await verifySubjectToken("github-access-token", "gho_token")).toMatchObject({
      ok: true,
      subject: { providerUserId: "583231", providerEmail: undefined },
    });
  });

  it("falls back to no email when the /user/emails request errors", async () => {
    mockGitHubFetch({ emails: { reject: true } });
    expect(await verifySubjectToken("github-access-token", "gho_token")).toMatchObject({
      ok: true,
      subject: { providerEmail: undefined },
    });
  });

  it("never treats an unverified or non-primary email as the verified identity", async () => {
    mockGitHubFetch({
      emails: {
        body: [
          { email: "unverified-primary@example.com", primary: true, verified: false },
          { email: "verified-secondary@example.com", primary: false, verified: true },
        ],
      },
    });
    expect(await verifySubjectToken("github-access-token", "gho_token")).toMatchObject({
      ok: true,
      subject: { providerEmail: undefined },
    });
  });

  it("resolves an identity from id+login even when the display fields are absent", async () => {
    // Validation is fail-closed on the identity keys only; a valid-but-partial
    // body (no name/avatar) must still resolve, not be rejected.
    mockGitHubFetch({ user: { body: { id: 583231, login: "octocat" } } });
    expect(await verifySubjectToken("github-access-token", "gho_token")).toMatchObject({
      ok: true,
      subject: { providerUserId: "583231", providerLogin: "octocat", displayName: "octocat" },
    });
  });

  it("fails closed on a malformed 200 /user body instead of minting a 'undefined' subject", async () => {
    // A 200 whose body is missing `id` must not collapse to providerUserId
    // "undefined" — treat it as the provider failing, fail closed, retryable.
    mockGitHubFetch({ user: { body: { login: "octocat", avatar_url: "https://a/x" } } });
    expect(await verifySubjectToken("github-access-token", "gho_token")).toEqual({
      ok: false,
      failure: "provider_unavailable",
    });
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

  it("maps 429 throttling to provider_unavailable, not subject_rejected", async () => {
    mockFetchResponse(429, { message: "rate limited" });
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

  it("never exposes an unverified email as the subject's providerEmail", async () => {
    for (const email_verified of [false, undefined]) {
      mockFetchResponse(200, {
        sub: "1078462347",
        email: "victim@example.com",
        ...(email_verified === undefined ? {} : { email_verified }),
        name: "A Person",
      });
      const result = await verifySubjectToken("google-access-token", "ya29.token");
      expect(result).toMatchObject({
        ok: true,
        subject: { providerUserId: "1078462347", providerEmail: undefined },
      });
    }
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
