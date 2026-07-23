import { afterEach, describe, it, expect, vi } from "vitest";
import { checkGitHubOrganizationAccess } from "./github-org-membership";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("checkGitHubOrganizationAccess", () => {
  it("returns true when any configured organization membership is active", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ state: "pending" })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: "active" }))
      ) as unknown as typeof fetch;

    await expect(
      checkGitHubOrganizationAccess({
        accessToken: "token",
        allowedOrganizations: ["pending-org", "active-org"],
        fetchImpl,
        userAgent: "Test App",
      })
    ).resolves.toEqual({ allowed: true, reason: "active_membership", organization: "active-org" });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/user/memberships/orgs/active-org",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer token",
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Test App",
        }) as HeadersInit,
      })
    );
  });

  it("returns early after the first active membership", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ state: "active" })));

    await expect(
      checkGitHubOrganizationAccess({
        accessToken: "token",
        allowedOrganizations: ["active-org", "other-org"],
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).resolves.toEqual({ allowed: true, reason: "active_membership", organization: "active-org" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns false for pending membership", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ state: "pending" })));

    await expect(
      checkGitHubOrganizationAccess({
        accessToken: "token",
        allowedOrganizations: ["acme"],
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).resolves.toEqual({ allowed: false, reason: "not_member" });

    expect(info).toHaveBeenCalledWith(
      "[github-org-access] membership not active",
      expect.objectContaining({
        org: "acme",
        state: "pending",
        elapsedMs: expect.any(Number),
      })
    );
  });

  it("returns not_member for denied GitHub responses", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(
      async () =>
        new Response("Not Found", {
          status: 404,
          headers: {
            "x-github-request-id": "github-request-id",
            "x-ratelimit-limit": "60",
            "x-ratelimit-remaining": "59",
            "x-ratelimit-reset": "1710000000",
          },
        })
    );

    await expect(
      checkGitHubOrganizationAccess({
        accessToken: "token",
        allowedOrganizations: ["acme"],
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).resolves.toEqual({ allowed: false, reason: "not_member" });

    expect(warn).toHaveBeenCalledWith(
      "[github-org-access] membership request failed",
      expect.objectContaining({
        org: "acme",
        status: 404,
        requestId: "github-request-id",
        rateLimitLimit: "60",
        rateLimitRemaining: "59",
        rateLimitReset: "1710000000",
        elapsedMs: expect.any(Number),
        hint: expect.any(String),
      })
    );
  });

  it("returns unavailable for operational GitHub responses", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(
      async () =>
        new Response("rate limited", {
          status: 429,
          headers: {
            "x-github-request-id": "github-request-id",
            "x-ratelimit-remaining": "0",
            "retry-after": "30",
          },
        })
    );

    await expect(
      checkGitHubOrganizationAccess({
        accessToken: "token",
        allowedOrganizations: ["acme"],
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).resolves.toEqual({ allowed: false, reason: "unavailable" });

    expect(warn).toHaveBeenCalledWith(
      "[github-org-access] membership request failed",
      expect.objectContaining({
        org: "acme",
        status: 429,
        requestId: "github-request-id",
        rateLimitRemaining: "0",
        retryAfter: "30",
        elapsedMs: expect.any(Number),
      })
    );
  });

  it("returns false without an access token or org allowlist", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      checkGitHubOrganizationAccess({ accessToken: undefined, allowedOrganizations: ["acme"] })
    ).resolves.toEqual({ allowed: false, reason: "unavailable" });

    await expect(
      checkGitHubOrganizationAccess({ accessToken: "token", allowedOrganizations: [] })
    ).resolves.toEqual({ allowed: false, reason: "not_member" });

    expect(warn).toHaveBeenCalledWith("[github-org-access] membership check skipped", {
      reason: "missing_access_token",
      organizationCount: 1,
    });
  });

  it("URL-encodes organization names", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ state: "active" })));

    await checkGitHubOrganizationAccess({
      accessToken: "token",
      allowedOrganizations: ["acme labs"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/user/memberships/orgs/acme%20labs",
      expect.any(Object)
    );
  });

  it("flags a missing membership state as unusable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ state: null })));

    await expect(
      checkGitHubOrganizationAccess({
        accessToken: "token",
        allowedOrganizations: ["acme"],
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).resolves.toEqual({ allowed: false, reason: "unavailable" });

    expect(warn).toHaveBeenCalledWith(
      "[github-org-access] membership response unusable state",
      expect.objectContaining({
        org: "acme",
        state: null,
        elapsedMs: expect.any(Number),
      })
    );
  });

  it("flags a non-object membership response as unusable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify("active")));

    await expect(
      checkGitHubOrganizationAccess({
        accessToken: "token",
        allowedOrganizations: ["acme"],
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).resolves.toEqual({ allowed: false, reason: "unavailable" });

    expect(warn).toHaveBeenCalledWith(
      "[github-org-access] membership response unusable state",
      expect.objectContaining({
        org: "acme",
        state: null,
        elapsedMs: expect.any(Number),
      })
    );
  });

  it("flags an unexpected membership state as unusable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ state: "unknown" })));

    await expect(
      checkGitHubOrganizationAccess({
        accessToken: "token",
        allowedOrganizations: ["acme"],
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).resolves.toEqual({ allowed: false, reason: "unavailable" });

    expect(warn).toHaveBeenCalledWith(
      "[github-org-access] membership response unusable state",
      expect.objectContaining({
        org: "acme",
        state: "unknown",
        elapsedMs: expect.any(Number),
      })
    );
  });

  it("returns unavailable for malformed membership responses", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response("not-json"));

    await expect(
      checkGitHubOrganizationAccess({
        accessToken: "token",
        allowedOrganizations: ["acme"],
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).resolves.toEqual({ allowed: false, reason: "unavailable" });

    expect(warn).toHaveBeenCalledWith(
      "[github-org-access] membership request error",
      expect.objectContaining({
        org: "acme",
        error: expect.any(String),
        message: expect.any(String),
        elapsedMs: expect.any(Number),
      })
    );
  });

  it("aborts timed out membership requests", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        })
    ) as unknown as typeof fetch;

    const result = checkGitHubOrganizationAccess({
      accessToken: "token",
      allowedOrganizations: ["acme"],
      fetchImpl,
      timeoutMs: 50,
    });

    await vi.advanceTimersByTimeAsync(50);
    await expect(result).resolves.toEqual({ allowed: false, reason: "unavailable" });
    expect(warn).toHaveBeenCalledWith(
      "[github-org-access] membership request error",
      expect.objectContaining({
        org: "acme",
        error: "AbortError",
        message: "Aborted",
        elapsedMs: expect.any(Number),
      })
    );
  });
});
