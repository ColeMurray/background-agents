import { describe, expect, it, vi } from "vitest";
import { GitHubProviderIdentityResolver } from "./github-identity";

describe("GitHubProviderIdentityResolver", () => {
  const config = {
    issuer: "https://github.com",
    userAgent: "Open Inspect Test",
  };

  it("rejects a non-canonical GitHub issuer", () => {
    expect(
      () =>
        new GitHubProviderIdentityResolver({
          ...config,
          issuer: "https://github.com.attacker.example",
        })
    ).toThrow(expect.objectContaining({ failure: "invalid_configuration" }));
  });

  it("resolves a verified provider identity from an existing access token", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          id: 583_231,
          login: "octocat",
          name: "The Octocat",
          avatar_url: "https://avatars.example/octocat",
        })
      )
      .mockResolvedValueOnce(
        Response.json([
          {
            email: "Primary@Example.com",
            primary: true,
            verified: true,
            visibility: "private",
          },
          {
            email: "PRIMARY@example.com",
            primary: false,
            verified: true,
            visibility: null,
          },
          {
            email: "unverified@example.com",
            primary: false,
            verified: false,
            visibility: null,
          },
        ])
      );
    const resolver = new GitHubProviderIdentityResolver(config, { fetch });

    await expect(resolver.resolveIdentity("ghu-access")).resolves.toEqual({
      provider: "github",
      issuer: "https://github.com",
      subject: "583231",
      login: "octocat",
      displayName: "The Octocat",
      avatarUrl: "https://avatars.example/octocat",
      verifiedEmails: ["primary@example.com"],
      primaryEmail: "primary@example.com",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("preserves the Workers receiver when using the default global fetch", async () => {
    const runtimeFetch = vi.fn(async function (
      this: unknown,
      input: RequestInfo | URL
    ): Promise<Response> {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
      if (String(input) === "https://api.github.com/user") {
        return Response.json({
          id: 583_231,
          login: "octocat",
          name: "The Octocat",
          avatar_url: null,
        });
      }
      return Response.json([
        {
          email: "octocat@example.com",
          primary: true,
          verified: true,
          visibility: null,
        },
      ]);
    });
    vi.stubGlobal("fetch", runtimeFetch);

    try {
      const resolver = new GitHubProviderIdentityResolver(config);

      await expect(resolver.resolveIdentity("ghu-access")).resolves.toMatchObject({
        subject: "583231",
        primaryEmail: "octocat@example.com",
      });
      expect(runtimeFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retries one transient GitHub network failure", async () => {
    let userAttempts = 0;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://api.github.com/user") {
        userAttempts += 1;
        if (userAttempts === 1) {
          throw new TypeError("temporary network failure");
        }
        return Response.json({
          id: 583_231,
          login: "octocat",
          name: "The Octocat",
          avatar_url: null,
        });
      }
      return Response.json([
        {
          email: "octocat@example.com",
          primary: true,
          verified: true,
          visibility: null,
        },
      ]);
    });
    const resolver = new GitHubProviderIdentityResolver(config, { fetch });

    await expect(resolver.resolveIdentity("ghu-access")).resolves.toMatchObject({
      subject: "583231",
      primaryEmail: "octocat@example.com",
    });
    expect(userAttempts).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("preserves the final network failure for provider diagnostics", async () => {
    const cause = new TypeError("persistent network failure");
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(cause);
    const resolver = new GitHubProviderIdentityResolver(config, { fetch });

    await expect(resolver.resolveIdentity("ghu-access")).rejects.toMatchObject({
      name: "OAuthProviderError",
      failure: "provider_unavailable",
      cause,
    });
  });

  it("logs a sanitized diagnostic after the network retry is exhausted", async () => {
    const cause = new TypeError("persistent network failure");
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(cause);
    const logger = { error: vi.fn() };
    const resolver = new GitHubProviderIdentityResolver(config, { fetch, logger });

    await expect(resolver.resolveIdentity("ghu-access")).rejects.toMatchObject({
      failure: "provider_unavailable",
    });
    expect(logger.error).toHaveBeenCalledWith("GitHub provider request failed", {
      event: "auth.github_provider_request_failed",
      attempts: 2,
      error: cause,
    });
  });

  it("names the missing App permission when GitHub rejects the email lookup", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      if (String(input) === "https://api.github.com/user") {
        return Response.json({ id: 583_231, login: "octocat" });
      }
      return Response.json(
        { message: "Resource not accessible by integration" },
        { status: 403, headers: { "X-RateLimit-Remaining": "4999" } }
      );
    });
    const logger = { error: vi.fn() };
    const resolver = new GitHubProviderIdentityResolver(config, { fetch, logger });

    await expect(resolver.resolveIdentity("ghu-access")).rejects.toMatchObject({
      name: "OAuthProviderError",
      failure: "provider_rejected",
      message: "GitHub email lookup was rejected",
    });
    expect(logger.error).toHaveBeenCalledWith("GitHub email lookup was rejected", {
      event: "auth.github_email_lookup_failed",
      http_status: 403,
      hint: "Check that the GitHub App has the Account permission 'Email addresses: Read-only', then sign in again.",
    });
  });

  it("treats a rate-limited GitHub email lookup as unavailable", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      if (String(input) === "https://api.github.com/user") {
        return Response.json({ id: 583_231, login: "octocat" });
      }
      return Response.json(
        { message: "API rate limit exceeded" },
        { status: 403, headers: { "X-RateLimit-Remaining": "0" } }
      );
    });
    const logger = { error: vi.fn() };
    const resolver = new GitHubProviderIdentityResolver(config, { fetch, logger });

    await expect(resolver.resolveIdentity("ghu-access")).rejects.toMatchObject({
      failure: "provider_unavailable",
      message: "GitHub email lookup was not successful",
    });
    expect(logger.error).toHaveBeenCalledWith("GitHub email lookup was not successful", {
      event: "auth.github_email_lookup_failed",
      http_status: 403,
    });
  });

  it("treats a secondary rate limit on the email lookup as unavailable", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      if (String(input) === "https://api.github.com/user") {
        return Response.json({ id: 583_231, login: "octocat" });
      }
      return Response.json(
        { message: "You have exceeded a secondary rate limit." },
        { status: 403, headers: { "Retry-After": "60", "X-RateLimit-Remaining": "4990" } }
      );
    });
    const logger = { error: vi.fn() };
    const resolver = new GitHubProviderIdentityResolver(config, { fetch, logger });

    await expect(resolver.resolveIdentity("ghu-access")).rejects.toMatchObject({
      failure: "provider_unavailable",
    });
    expect(logger.error).toHaveBeenCalledWith("GitHub email lookup was not successful", {
      event: "auth.github_email_lookup_failed",
      http_status: 403,
    });
  });

  it("treats a secondary rate limit without Retry-After as unavailable", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      if (String(input) === "https://api.github.com/user") {
        return Response.json({ id: 583_231, login: "octocat" });
      }
      return Response.json(
        { message: "You have exceeded a secondary rate limit. Please wait a few minutes." },
        { status: 403, headers: { "X-RateLimit-Remaining": "4990" } }
      );
    });
    const logger = { error: vi.fn() };
    const resolver = new GitHubProviderIdentityResolver(config, { fetch, logger });

    await expect(resolver.resolveIdentity("ghu-access")).rejects.toMatchObject({
      failure: "provider_unavailable",
    });
    expect(logger.error).toHaveBeenCalledWith("GitHub email lookup was not successful", {
      event: "auth.github_email_lookup_failed",
      http_status: 403,
    });
  });

  it("does not wait on a stalled GitHub error body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      if (String(input) === "https://api.github.com/user") {
        return Response.json({ id: 583_231, login: "octocat" });
      }
      return new Response(new ReadableStream({ start() {} }), { status: 403 });
    });
    const logger = { error: vi.fn() };
    const resolver = new GitHubProviderIdentityResolver(config, {
      fetch,
      logger,
      requestTimeoutMs: 10,
    });

    await expect(resolver.resolveIdentity("ghu-access")).rejects.toMatchObject({
      failure: "provider_unavailable",
    });
  });

  it("logs the GitHub status when the email lookup fails for another reason", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      if (String(input) === "https://api.github.com/user") {
        return Response.json({ id: 583_231, login: "octocat" });
      }
      return new Response("bad gateway", { status: 502 });
    });
    const logger = { error: vi.fn() };
    const resolver = new GitHubProviderIdentityResolver(config, { fetch, logger });

    await expect(resolver.resolveIdentity("ghu-access")).rejects.toMatchObject({
      failure: "provider_unavailable",
      message: "GitHub email lookup was not successful",
    });
    expect(logger.error).toHaveBeenCalledWith("GitHub email lookup was not successful", {
      event: "auth.github_email_lookup_failed",
      http_status: 502,
    });
  });

  it("constructs subsequent GitHub email page URLs locally", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      email: `unverified-${index}@example.com`,
      primary: false,
      verified: false,
      visibility: null,
    }));
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          id: 583_231,
          login: "octocat",
          name: null,
          avatar_url: null,
        })
      )
      .mockResolvedValueOnce(
        Response.json(firstPage, {
          headers: {
            Link: '<https://attacker.example/collect>; rel="next"',
          },
        })
      )
      .mockResolvedValueOnce(
        Response.json([
          {
            email: "later-page@example.com",
            primary: true,
            verified: true,
            visibility: null,
          },
        ])
      );
    const resolver = new GitHubProviderIdentityResolver(config, { fetch });

    const result = await resolver.resolveIdentity("ghu-access");

    expect(result.verifiedEmails).toEqual(["later-page@example.com"]);
    expect(result.primaryEmail).toBe("later-page@example.com");
    expect(String(fetch.mock.calls[2][0])).toBe(
      "https://api.github.com/user/emails?per_page=100&page=2"
    );
  });

  it("bounds GitHub email pagination", async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      email: `email-${index}@example.com`,
      primary: false,
      verified: true,
      visibility: null,
    }));
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      if (String(input) === "https://api.github.com/user") {
        return Response.json({ id: 583_231, login: "octocat" });
      }
      return Response.json(fullPage, {
        headers: {
          Link: '<https://api.github.com/user/emails?per_page=100&page=999>; rel="next"',
        },
      });
    });
    const resolver = new GitHubProviderIdentityResolver(config, { fetch });

    await expect(resolver.resolveIdentity("ghu-access")).rejects.toMatchObject({
      name: "OAuthProviderError",
      failure: "malformed_response",
      message: "GitHub email pagination exceeded its limit",
    });
    expect(fetch).toHaveBeenCalledTimes(11);
    expect(String(fetch.mock.calls[10][0])).toBe(
      "https://api.github.com/user/emails?per_page=100&page=10"
    );
  });
});
