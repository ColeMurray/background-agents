import { describe, expect, it, vi } from "vitest";
import { GitHubEmailPermissionError, GitHubProviderIdentityResolver } from "./github-identity";

/** Like a real fetch body, this stalled stream errors once the request signal aborts. */
function stalledBody(signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      signal?.addEventListener("abort", () => controller.error(signal.reason));
    },
  });
}

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

  it("aborts the request instead of waiting on a stalled GitHub error body", async () => {
    let emailSignal: AbortSignal | null | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
      if (String(input) === "https://api.github.com/user") {
        return Response.json({ id: 583_231, login: "octocat" });
      }
      emailSignal = init?.signal;
      return new Response(stalledBody(init?.signal), { status: 403 });
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
    expect(emailSignal?.aborted).toBe(true);
  });

  it("aborts the request instead of waiting on a stalled GitHub success body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
      if (String(input) === "https://api.github.com/user") {
        return new Response(stalledBody(init?.signal), { status: 200 });
      }
      return Response.json([
        { email: "octocat@example.com", primary: true, verified: true, visibility: null },
      ]);
    });
    const resolver = new GitHubProviderIdentityResolver(config, {
      fetch,
      logger: { error: vi.fn() },
      requestTimeoutMs: 10,
    });

    await expect(resolver.resolveIdentity("ghu-access")).rejects.toMatchObject({
      failure: "provider_unavailable",
      message: "GitHub user response was not read",
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

  // #2153: a missing Email addresses permission answers 403 with no hint.
  function emailsFetch(status: number, headers?: Record<string, string>, body: unknown = {}) {
    return vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      if (String(input) === "https://api.github.com/user") {
        return Response.json({ id: 583_231, login: "octocat" });
      }
      return new Response(JSON.stringify(body), { status, headers });
    });
  }

  it("names the missing Email addresses permission on a 403 from /user/emails", async () => {
    const logger = { error: vi.fn() };
    const resolver = new GitHubProviderIdentityResolver(config, {
      fetch: emailsFetch(403, undefined, { message: "Resource not accessible by integration" }),
      logger,
    });

    const lookup = resolver.resolveIdentity("ghu-access");
    await expect(lookup).rejects.toBeInstanceOf(GitHubEmailPermissionError);
    await expect(lookup).rejects.toMatchObject({
      name: "GitHubEmailPermissionError",
      failure: "provider_rejected",
      message:
        "GitHub email lookup was not successful (status 403; Grant the GitHub App the Account -> Email addresses: Read-only permission and approve the installation update (see docs/GETTING_STARTED.md step 7))",
    });
    expect(logger.error).toHaveBeenCalledWith("GitHub email lookup failed", {
      event: "auth.github_email_lookup_failed",
      status: 403,
      githubMessage: "Resource not accessible by integration",
      hint: "Grant the GitHub App the Account -> Email addresses: Read-only permission and approve the installation update (see docs/GETTING_STARTED.md step 7)",
    });
  });

  it.each([
    ["empty", ""],
    ["missing message", "{}"],
    ["unrelated denial", JSON.stringify({ message: "Access to this resource has been blocked" })],
    ["invalid JSON", "not JSON"],
    ["plain-text permission message", "Resource not accessible by integration"],
  ])("leaves a 403 with %s unclassified", async (_label, body) => {
    const logger = { error: vi.fn() };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (input) =>
        String(input) === "https://api.github.com/user"
          ? Response.json({ id: 583231, login: "octocat" })
          : new Response(body, { status: 403 })
      );
    const resolver = new GitHubProviderIdentityResolver(config, { fetch, logger });

    await expect(resolver.resolveIdentity("ghu-access")).rejects.toMatchObject({
      failure: "provider_unavailable",
      message: "GitHub email lookup was not successful (status 403)",
    });
    expect(logger.error.mock.calls[0][1]).not.toHaveProperty("hint");
  });

  it("leaves an unreadable 403 unclassified", async () => {
    const logger = { error: vi.fn() };
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) =>
      String(input) === "https://api.github.com/user"
        ? Response.json({ id: 583231, login: "octocat" })
        : new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("read failed"));
              },
            }),
            { status: 403 }
          )
    );
    const resolver = new GitHubProviderIdentityResolver(config, { fetch, logger });

    await expect(resolver.resolveIdentity("ghu-access")).rejects.toMatchObject({
      failure: "provider_unavailable",
    });
    expect(logger.error.mock.calls[0][1]).not.toHaveProperty("hint");
  });

  it.each(["json", "text"])(
    "cancels an oversized %s error body before reading it all",
    async (format) => {
      const body =
        format === "json"
          ? JSON.stringify({
              message: "Resource not accessible by integration",
              padding: "x".repeat(65536),
            })
          : "x".repeat(65536);
      const bytes = new TextEncoder().encode(body);
      let offset = 0;
      const cancel = vi.fn();
      const logger = { error: vi.fn() };
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) =>
        String(input) === "https://api.github.com/user"
          ? Response.json({ id: 583231, login: "octocat" })
          : new Response(
              new ReadableStream({
                pull(controller) {
                  if (offset >= bytes.byteLength) {
                    controller.close();
                    return;
                  }
                  controller.enqueue(bytes.slice(offset, offset + 1024));
                  offset += 1024;
                },
                cancel,
              }),
              { status: 403 }
            )
      );
      const resolver = new GitHubProviderIdentityResolver(config, { fetch, logger });

      await expect(resolver.resolveIdentity("ghu-access")).rejects.toMatchObject({
        failure: "provider_unavailable",
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect(offset).toBeLessThan(bytes.byteLength);
      expect(logger.error).toHaveBeenCalledWith("GitHub email lookup failed", {
        event: "auth.github_email_lookup_failed",
        status: 403,
      });
    }
  );

  it("caps a JSON diagnostic message before logging it", async () => {
    const logger = { error: vi.fn() };
    const resolver = new GitHubProviderIdentityResolver(config, {
      fetch: emailsFetch(403, undefined, { message: "x".repeat(1000) }),
      logger,
    });

    await expect(resolver.resolveIdentity("ghu-access")).rejects.toMatchObject({
      failure: "provider_unavailable",
    });
    expect(logger.error).toHaveBeenCalledWith("GitHub email lookup failed", {
      event: "auth.github_email_lookup_failed",
      status: 403,
      githubMessage: "x".repeat(200),
    });
  });

  it("withholds the permission hint when a 403 is rate limiting", async () => {
    const logger = { error: vi.fn() };
    const resolver = new GitHubProviderIdentityResolver(config, {
      fetch: emailsFetch(
        403,
        { "x-ratelimit-remaining": "0" },
        { message: "Resource not accessible by integration" }
      ),
      logger,
    });

    await expect(resolver.resolveIdentity("ghu-access")).rejects.toMatchObject({
      failure: "provider_unavailable",
      message: "GitHub email lookup was not successful (status 403)",
    });
    expect(logger.error).toHaveBeenCalledWith("GitHub email lookup failed", {
      event: "auth.github_email_lookup_failed",
      status: 403,
      githubMessage: "Resource not accessible by integration",
    });
  });

  it("withholds the permission hint on a secondary rate limit", async () => {
    const logger = { error: vi.fn() };
    const resolver = new GitHubProviderIdentityResolver(config, {
      fetch: emailsFetch(
        403,
        { "retry-after": "60" },
        { message: "Resource not accessible by integration" }
      ),
      logger,
    });

    await expect(resolver.resolveIdentity("ghu-access")).rejects.toMatchObject({
      failure: "provider_unavailable",
      message: "GitHub email lookup was not successful (status 403)",
    });
    expect(logger.error).toHaveBeenCalledWith("GitHub email lookup failed", {
      event: "auth.github_email_lookup_failed",
      status: 403,
      githubMessage: "Resource not accessible by integration",
    });
  });

  it("withholds the permission hint on a secondary rate limit named only by the body", async () => {
    const logger = { error: vi.fn() };
    const resolver = new GitHubProviderIdentityResolver(config, {
      fetch: emailsFetch(
        403,
        { "x-ratelimit-remaining": "4800" },
        {
          message:
            "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
        }
      ),
      logger,
    });

    await expect(resolver.resolveIdentity("ghu-access")).rejects.toMatchObject({
      failure: "provider_unavailable",
      message: "GitHub email lookup was not successful (status 403)",
    });
    expect(logger.error).toHaveBeenCalledWith("GitHub email lookup failed", {
      event: "auth.github_email_lookup_failed",
      status: 403,
      githubMessage:
        "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
    });
  });

  it("withholds the permission hint on a 403 past page 1", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      email: `unverified-${index}@example.com`,
      primary: false,
      verified: false,
      visibility: null,
    }));
    const logger = { error: vi.fn() };
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      if (String(input) === "https://api.github.com/user") {
        return Response.json({ id: 583_231, login: "octocat" });
      }
      if (String(input).includes("page=2")) {
        return new Response(JSON.stringify({ message: "Resource not accessible by integration" }), {
          status: 403,
        });
      }
      return Response.json(firstPage, {
        headers: {
          Link: '<https://api.github.com/user/emails?per_page=100&page=2>; rel="next"',
        },
      });
    });
    const resolver = new GitHubProviderIdentityResolver(config, { fetch, logger });

    await expect(resolver.resolveIdentity("ghu-access")).rejects.toMatchObject({
      failure: "provider_unavailable",
      message: "GitHub email lookup was not successful (status 403)",
    });
    expect(logger.error).toHaveBeenCalledWith("GitHub email lookup failed", {
      event: "auth.github_email_lookup_failed",
      status: 403,
      githubMessage: "Resource not accessible by integration",
    });
  });

  it("carries the status without a hint on a non-403 email failure", async () => {
    const logger = { error: vi.fn() };
    const resolver = new GitHubProviderIdentityResolver(config, {
      fetch: emailsFetch(500),
      logger,
    });

    await expect(resolver.resolveIdentity("ghu-access")).rejects.toMatchObject({
      failure: "provider_unavailable",
      message: "GitHub email lookup was not successful (status 500)",
    });
    expect(logger.error).toHaveBeenCalledWith("GitHub email lookup failed", {
      event: "auth.github_email_lookup_failed",
      status: 500,
    });
  });
});
