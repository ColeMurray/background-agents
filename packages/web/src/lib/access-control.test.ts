import { describe, it, expect } from "vitest";
import { parseAllowlist, checkAccessAllowed } from "./access-control";

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

describe("checkAccessAllowed", () => {
  describe("when both allowlists are empty", () => {
    it("allows all users", () => {
      const config = { allowedDomains: [], allowedUsers: [] };

      expect(checkAccessAllowed(config, {})).toBe(true);
      expect(checkAccessAllowed(config, { githubUsername: "anyuser" })).toBe(true);
      expect(checkAccessAllowed(config, { email: "anyone@example.com" })).toBe(true);
    });
  });

  describe("when allowedUsers is set", () => {
    const config = { allowedDomains: [], allowedUsers: ["alloweduser"] };

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

  describe("when allowedUsers contains email addresses (Google auth)", () => {
    const config = { allowedDomains: [], allowedUsers: ["alice@company.com"] };

    it("allows users with matching email", () => {
      expect(checkAccessAllowed(config, { email: "alice@company.com" })).toBe(true);
    });

    it("allows users with different case email", () => {
      expect(checkAccessAllowed(config, { email: "Alice@Company.COM" })).toBe(true);
    });

    it("denies users with non-matching email", () => {
      expect(checkAccessAllowed(config, { email: "bob@company.com" })).toBe(false);
    });
  });

  describe("when allowedDomains is set", () => {
    const config = { allowedDomains: ["company.com"], allowedUsers: [] };

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

  describe("multiple values in allowlists", () => {
    const config = {
      allowedDomains: ["company.com", "partner.org"],
      allowedUsers: ["admin", "developer"],
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
