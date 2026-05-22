import { afterEach, describe, it, expect, vi } from "vitest";
import {
  parseAllowlist,
  parseBooleanEnv,
  checkAccessAllowed,
  checkGitHubOrganizationAccess,
  getAccessAllowReason,
} from "./access-control";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("parseAllowlist", () => {
  it("returns empty array for undefined", () => {
    expect(parseAllowlist(undefined)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseAllowlist("")).toEqual([]);
  });

  it("parses single value", () => {
    expect(parseAllowlist("user1")).toEqual(["user1"]);
  });

  it("parses comma-separated values", () => {
    expect(parseAllowlist("user1,user2,user3")).toEqual(["user1", "user2", "user3"]);
  });

  it("trims whitespace", () => {
    expect(parseAllowlist("  user1 , user2  ,  user3  ")).toEqual(["user1", "user2", "user3"]);
  });

  it("converts to lowercase", () => {
    expect(parseAllowlist("User1,USER2,UsEr3")).toEqual(["user1", "user2", "user3"]);
  });

  it("filters empty values", () => {
    expect(parseAllowlist("user1,,user2,  ,user3")).toEqual(["user1", "user2", "user3"]);
  });
});

describe("parseBooleanEnv", () => {
  it("returns false for undefined and empty values", () => {
    expect(parseBooleanEnv(undefined)).toBe(false);
    expect(parseBooleanEnv("")).toBe(false);
    expect(parseBooleanEnv("   ")).toBe(false);
  });

  it("returns true only for true", () => {
    expect(parseBooleanEnv("true")).toBe(true);
    expect(parseBooleanEnv(" TRUE ")).toBe(true);
    expect(parseBooleanEnv("false")).toBe(false);
    expect(parseBooleanEnv("1")).toBe(false);
  });
});

describe("checkAccessAllowed", () => {
  describe("when both allowlists are empty", () => {
    it("denies all users by default", () => {
      const config = { allowedDomains: [], allowedUsers: [], unsafeAllowAllUsers: false };

      expect(checkAccessAllowed(config, {})).toBe(false);
      expect(checkAccessAllowed(config, { githubUsername: "anyuser" })).toBe(false);
      expect(checkAccessAllowed(config, { email: "anyone@example.com" })).toBe(false);
    });

    it("allows all users when unsafeAllowAllUsers is enabled", () => {
      const config = { allowedDomains: [], allowedUsers: [], unsafeAllowAllUsers: true };

      expect(checkAccessAllowed(config, {})).toBe(true);
      expect(checkAccessAllowed(config, { githubUsername: "anyuser" })).toBe(true);
      expect(checkAccessAllowed(config, { email: "anyone@example.com" })).toBe(true);
    });
  });

  describe("when allowedOrganizations is set", () => {
    const config = {
      allowedDomains: [],
      allowedUsers: [],
      allowedOrganizations: ["Acme"],
      unsafeAllowAllUsers: false,
    };

    it("allows users with active org membership", () => {
      expect(checkAccessAllowed(config, { activeOrganizations: ["acme"] })).toBe(true);
    });

    it("allows users with different org case", () => {
      expect(checkAccessAllowed(config, { activeOrganizations: ["Acme"] })).toBe(true);
    });

    it("denies users without matching active org membership", () => {
      expect(checkAccessAllowed(config, { activeOrganizations: ["other"] })).toBe(false);
      expect(checkAccessAllowed(config, {})).toBe(false);
    });
  });

  describe("when allowedUsers is set", () => {
    const config = {
      allowedDomains: [],
      allowedUsers: ["alloweduser"],
      unsafeAllowAllUsers: false,
    };

    it("allows users in the list", () => {
      expect(checkAccessAllowed(config, { githubUsername: "alloweduser" })).toBe(true);
    });

    it("allows users with different case", () => {
      expect(checkAccessAllowed(config, { githubUsername: "AllowedUser" })).toBe(true);
      expect(checkAccessAllowed(config, { githubUsername: "ALLOWEDUSER" })).toBe(true);
    });

    it("denies users not in the list", () => {
      expect(checkAccessAllowed(config, { githubUsername: "otheruser" })).toBe(false);
    });

    it("denies when no username provided", () => {
      expect(checkAccessAllowed(config, {})).toBe(false);
      expect(checkAccessAllowed(config, { email: "user@example.com" })).toBe(false);
    });
  });

  describe("when allowedDomains is set", () => {
    const config = {
      allowedDomains: ["company.com"],
      allowedUsers: [],
      unsafeAllowAllUsers: false,
    };

    it("allows users with matching email domain", () => {
      expect(checkAccessAllowed(config, { email: "user@company.com" })).toBe(true);
    });

    it("allows users with different case email", () => {
      expect(checkAccessAllowed(config, { email: "User@COMPANY.COM" })).toBe(true);
    });

    it("denies users with non-matching email domain", () => {
      expect(checkAccessAllowed(config, { email: "user@other.com" })).toBe(false);
    });

    it("denies when no email provided", () => {
      expect(checkAccessAllowed(config, {})).toBe(false);
      expect(checkAccessAllowed(config, { githubUsername: "someuser" })).toBe(false);
    });
  });

  describe("when both allowedUsers and allowedDomains are set (OR logic)", () => {
    const config = {
      allowedDomains: ["company.com"],
      allowedUsers: ["specialuser"],
      unsafeAllowAllUsers: false,
    };

    it("allows users matching username", () => {
      expect(checkAccessAllowed(config, { githubUsername: "specialuser" })).toBe(true);
    });

    it("allows users matching email domain", () => {
      expect(checkAccessAllowed(config, { email: "someone@company.com" })).toBe(true);
    });

    it("allows users matching either condition", () => {
      expect(
        checkAccessAllowed(config, {
          githubUsername: "specialuser",
          email: "user@other.com",
        })
      ).toBe(true);

      expect(
        checkAccessAllowed(config, {
          githubUsername: "otheruser",
          email: "user@company.com",
        })
      ).toBe(true);
    });

    it("denies users matching neither condition", () => {
      expect(
        checkAccessAllowed(config, {
          githubUsername: "randomuser",
          email: "user@other.com",
        })
      ).toBe(false);
    });
  });

  describe("when allowedUsers, allowedDomains, and allowedOrganizations are set (OR logic)", () => {
    const config = {
      allowedDomains: ["company.com"],
      allowedUsers: ["specialuser"],
      allowedOrganizations: ["acme"],
      unsafeAllowAllUsers: false,
    };

    it("allows users matching org membership", () => {
      expect(checkAccessAllowed(config, { activeOrganizations: ["acme"] })).toBe(true);
    });

    it("denies users matching none of the configured policies", () => {
      expect(
        checkAccessAllowed(config, {
          githubUsername: "randomuser",
          email: "user@other.com",
          activeOrganizations: ["other"],
        })
      ).toBe(false);
    });
  });

  describe("when unsafeAllowAllUsers is true with populated allowlists", () => {
    const config = {
      allowedDomains: ["company.com"],
      allowedUsers: ["specialuser"],
      unsafeAllowAllUsers: true,
    };

    it("still enforces the allowlist for matching users", () => {
      expect(checkAccessAllowed(config, { githubUsername: "specialuser" })).toBe(true);
      expect(checkAccessAllowed(config, { email: "user@company.com" })).toBe(true);
    });

    it("denies users not in the allowlist", () => {
      expect(checkAccessAllowed(config, { githubUsername: "randomuser" })).toBe(false);
      expect(checkAccessAllowed(config, { email: "user@other.com" })).toBe(false);
    });

    it("does not bypass populated organization allowlists", () => {
      const orgConfig = {
        allowedDomains: [],
        allowedUsers: [],
        allowedOrganizations: ["acme"],
        unsafeAllowAllUsers: true,
      };

      expect(checkAccessAllowed(orgConfig, {})).toBe(false);
      expect(checkAccessAllowed(orgConfig, { activeOrganizations: ["other"] })).toBe(false);
      expect(checkAccessAllowed(orgConfig, { activeOrganizations: ["acme"] })).toBe(true);
    });
  });

  describe("multiple values in allowlists", () => {
    const config = {
      allowedDomains: ["company.com", "partner.org"],
      allowedUsers: ["admin", "developer"],
      unsafeAllowAllUsers: false,
    };

    it("allows any user from the list", () => {
      expect(checkAccessAllowed(config, { githubUsername: "admin" })).toBe(true);
      expect(checkAccessAllowed(config, { githubUsername: "developer" })).toBe(true);
    });

    it("allows any domain from the list", () => {
      expect(checkAccessAllowed(config, { email: "user@company.com" })).toBe(true);
      expect(checkAccessAllowed(config, { email: "user@partner.org" })).toBe(true);
    });
  });
});

describe("getAccessAllowReason", () => {
  it("returns the matching allow reason", () => {
    expect(
      getAccessAllowReason(
        { allowedDomains: [], allowedUsers: ["alice"], unsafeAllowAllUsers: false },
        { githubUsername: "Alice" }
      )
    ).toBe("username_allowlist");

    expect(
      getAccessAllowReason(
        { allowedDomains: ["company.com"], allowedUsers: [], unsafeAllowAllUsers: false },
        { email: "user@company.com" }
      )
    ).toBe("email_domain_allowlist");

    expect(
      getAccessAllowReason(
        {
          allowedDomains: [],
          allowedUsers: [],
          allowedOrganizations: ["acme"],
          unsafeAllowAllUsers: false,
        },
        { activeOrganizations: ["Acme"] }
      )
    ).toBe("org_membership");
  });
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
    ).resolves.toBe(true);

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
    ).resolves.toBe(true);

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
    ).resolves.toBe(false);

    expect(info).toHaveBeenCalledWith("[github-org-access] membership not active", {
      org: "acme",
      state: "pending",
    });
  });

  it("returns false for denied GitHub responses", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response("Not Found", { status: 404 }));

    await expect(
      checkGitHubOrganizationAccess({
        accessToken: "token",
        allowedOrganizations: ["acme"],
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).resolves.toBe(false);

    expect(warn).toHaveBeenCalledWith("[github-org-access] membership request failed", {
      org: "acme",
      status: 404,
      hint: expect.any(String),
    });
  });

  it("returns false without an access token or org allowlist", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      checkGitHubOrganizationAccess({ accessToken: undefined, allowedOrganizations: ["acme"] })
    ).resolves.toBe(false);

    await expect(
      checkGitHubOrganizationAccess({ accessToken: "token", allowedOrganizations: [] })
    ).resolves.toBe(false);

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

  it("logs missing membership state", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ state: null })));

    await expect(
      checkGitHubOrganizationAccess({
        accessToken: "token",
        allowedOrganizations: ["acme"],
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).resolves.toBe(false);

    expect(warn).toHaveBeenCalledWith("[github-org-access] membership response missing state", {
      org: "acme",
      state: null,
    });
  });

  it("logs unexpected membership state", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ state: "unknown" })));

    await expect(
      checkGitHubOrganizationAccess({
        accessToken: "token",
        allowedOrganizations: ["acme"],
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).resolves.toBe(false);

    expect(warn).toHaveBeenCalledWith("[github-org-access] membership response unexpected state", {
      org: "acme",
      state: "unknown",
    });
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
    await expect(result).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith("[github-org-access] membership request error", {
      org: "acme",
      error: "AbortError",
      message: "Aborted",
    });
  });
});
