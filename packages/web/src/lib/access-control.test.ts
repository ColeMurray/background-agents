import { describe, it, expect } from "vitest";
import { parseAllowlist, parseBooleanEnv, checkAccessAllowed } from "./access-control";

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
