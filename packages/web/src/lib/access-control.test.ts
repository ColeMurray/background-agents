import { describe, it, expect } from "vitest";
import {
  parseAllowlist,
  parseBooleanEnv,
  checkAccessAllowed,
  getAccessAllowReason,
} from "./access-control";

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
  describe("when all allowlists are empty", () => {
    it("denies all users by default", () => {
      const config = {
        allowedDomains: [],
        allowedUsers: [],
        allowedEmails: [],
        unsafeAllowAllUsers: false,
      };

      expect(checkAccessAllowed(config, {})).toBe(false);
      expect(checkAccessAllowed(config, { githubUsername: "anyuser" })).toBe(false);
      expect(checkAccessAllowed(config, { email: "anyone@example.com" })).toBe(false);
    });

    it("allows all users when unsafeAllowAllUsers is enabled", () => {
      const config = {
        allowedDomains: [],
        allowedUsers: [],
        allowedEmails: [],
        unsafeAllowAllUsers: true,
      };

      expect(checkAccessAllowed(config, {})).toBe(true);
      expect(checkAccessAllowed(config, { githubUsername: "anyuser" })).toBe(true);
      expect(checkAccessAllowed(config, { email: "anyone@example.com" })).toBe(true);
    });

    it("a populated allowedEmails disables the unsafe allow-all gate", () => {
      const config = {
        allowedDomains: [],
        allowedUsers: [],
        allowedEmails: ["listed@gmail.com"],
        unsafeAllowAllUsers: true,
      };

      // The gate only fires when ALL three lists are empty; once allowedEmails is
      // set, enforcement applies even with unsafeAllowAllUsers on.
      expect(checkAccessAllowed(config, { email: "listed@gmail.com" })).toBe(true);
      expect(checkAccessAllowed(config, { email: "other@gmail.com" })).toBe(false);
      expect(checkAccessAllowed(config, {})).toBe(false);
    });
  });

  describe("when only allowedOrganizations is set", () => {
    // Org membership is resolved asynchronously (checkGitHubOrganizationAccess),
    // never by this synchronous policy — so it can only deny here, while still
    // refusing to fall back to unsafe allow-all.
    const config = {
      allowedDomains: [],
      allowedUsers: [],
      allowedEmails: [],
      allowedOrganizations: ["acme"],
      unsafeAllowAllUsers: false,
    };

    it("denies synchronously — membership is checked asynchronously elsewhere", () => {
      expect(checkAccessAllowed(config, {})).toBe(false);
      expect(checkAccessAllowed(config, { githubUsername: "anyuser" })).toBe(false);
      expect(checkAccessAllowed(config, { email: "anyone@example.com" })).toBe(false);
    });

    it("keeps the unsafe allow-all gate closed because an allowlist is configured", () => {
      expect(checkAccessAllowed({ ...config, unsafeAllowAllUsers: true }, {})).toBe(false);
    });
  });

  describe("when allowedUsers is set", () => {
    const config = {
      allowedDomains: [],
      allowedUsers: ["alloweduser"],
      allowedEmails: [],
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

  describe("when allowedEmails is set", () => {
    const config = {
      allowedDomains: [],
      allowedUsers: [],
      allowedEmails: ["pm@gmail.com", "support@gmail.com"],
      unsafeAllowAllUsers: false,
    };

    it("allows an exact listed email — even on a shared domain like gmail.com", () => {
      expect(checkAccessAllowed(config, { email: "pm@gmail.com" })).toBe(true);
      expect(checkAccessAllowed(config, { email: "support@gmail.com" })).toBe(true);
    });

    it("matches case-insensitively", () => {
      expect(checkAccessAllowed(config, { email: "PM@Gmail.com" })).toBe(true);
    });

    it("does NOT admit other addresses on the same shared domain", () => {
      // The whole point of the exact-email list: a gmail.com address is admitted
      // without admitting every gmail.com account.
      expect(checkAccessAllowed(config, { email: "stranger@gmail.com" })).toBe(false);
    });

    it("denies when no email provided", () => {
      expect(checkAccessAllowed(config, {})).toBe(false);
      expect(checkAccessAllowed(config, { githubUsername: "pm" })).toBe(false);
    });
  });

  describe("when allowedDomains is set", () => {
    const config = {
      allowedDomains: ["company.com"],
      allowedUsers: [],
      allowedEmails: [],
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

  describe("when allowedUsers, allowedEmails and allowedDomains are set (OR logic)", () => {
    const config = {
      allowedDomains: ["company.com"],
      allowedUsers: ["specialuser"],
      allowedEmails: ["contractor@gmail.com"],
      unsafeAllowAllUsers: false,
    };

    it("allows users matching username", () => {
      expect(checkAccessAllowed(config, { githubUsername: "specialuser" })).toBe(true);
    });

    it("allows users matching exact email", () => {
      expect(checkAccessAllowed(config, { email: "contractor@gmail.com" })).toBe(true);
    });

    it("allows users matching email domain", () => {
      expect(checkAccessAllowed(config, { email: "someone@company.com" })).toBe(true);
    });

    it("allows users matching any condition", () => {
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

    it("denies users matching no condition", () => {
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
      allowedEmails: [],
      allowedOrganizations: ["acme"],
      unsafeAllowAllUsers: false,
    };

    it("allows users matching a synchronous list (username or domain)", () => {
      expect(checkAccessAllowed(config, { githubUsername: "specialuser" })).toBe(true);
      expect(checkAccessAllowed(config, { email: "user@company.com" })).toBe(true);
    });

    it("denies users matching none of the synchronous lists (org checked elsewhere)", () => {
      expect(
        checkAccessAllowed(config, {
          githubUsername: "randomuser",
          email: "user@other.com",
        })
      ).toBe(false);
    });
  });

  describe("when unsafeAllowAllUsers is true with populated allowlists", () => {
    const config = {
      allowedDomains: ["company.com"],
      allowedUsers: ["specialuser"],
      allowedEmails: [],
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

    it("does not bypass a populated organization allowlist", () => {
      const orgConfig = {
        allowedDomains: [],
        allowedUsers: [],
        allowedEmails: [],
        allowedOrganizations: ["acme"],
        unsafeAllowAllUsers: true,
      };

      // A populated org allowlist keeps the unsafe allow-all gate closed; the
      // synchronous check then denies (membership is resolved asynchronously).
      expect(checkAccessAllowed(orgConfig, {})).toBe(false);
      expect(checkAccessAllowed(orgConfig, { githubUsername: "anyuser" })).toBe(false);
    });
  });

  describe("multiple values in allowlists", () => {
    const config = {
      allowedDomains: ["company.com", "partner.org"],
      allowedUsers: ["admin", "developer"],
      allowedEmails: [],
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
        {
          allowedDomains: [],
          allowedUsers: ["alice"],
          allowedEmails: [],
          unsafeAllowAllUsers: false,
        },
        { githubUsername: "Alice" }
      )
    ).toBe("username_allowlist");

    expect(
      getAccessAllowReason(
        {
          allowedDomains: [],
          allowedUsers: [],
          allowedEmails: ["pm@gmail.com"],
          unsafeAllowAllUsers: false,
        },
        { email: "PM@gmail.com" }
      )
    ).toBe("email_allowlist");

    expect(
      getAccessAllowReason(
        {
          allowedDomains: ["company.com"],
          allowedUsers: [],
          allowedEmails: [],
          unsafeAllowAllUsers: false,
        },
        { email: "user@company.com" }
      )
    ).toBe("email_domain_allowlist");
  });
});
