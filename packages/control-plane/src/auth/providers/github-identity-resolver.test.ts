import { describe, expect, it, vi } from "vitest";
import { GitHubProviderIdentityResolver } from "./github-identity-resolver";

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

  it("paginates GitHub emails to exhaustion", async () => {
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
            Link: '<https://api.github.com/user/emails?per_page=100&page=2>; rel="next"',
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

  it("fails closed when GitHub email pagination metadata is malformed", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ id: 583_231, login: "octocat" }))
      .mockResolvedValueOnce(
        Response.json([], {
          headers: { Link: "this is not a valid Link header" },
        })
      );
    const resolver = new GitHubProviderIdentityResolver(config, { fetch });

    await expect(resolver.resolveIdentity("ghu-access")).rejects.toMatchObject({
      name: "OAuthProviderError",
      failure: "malformed_response",
    });
  });

  it("fails closed when GitHub repeats an email page", async () => {
    const repeatedPage = "https://api.github.com/user/emails?per_page=100&page=1";
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ id: 583_231, login: "octocat" }))
      .mockResolvedValueOnce(
        Response.json([], {
          headers: { Link: `<${repeatedPage}>; rel="next"` },
        })
      );
    const resolver = new GitHubProviderIdentityResolver(config, { fetch });

    await expect(resolver.resolveIdentity("ghu-access")).rejects.toMatchObject({
      name: "OAuthProviderError",
      failure: "malformed_response",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
