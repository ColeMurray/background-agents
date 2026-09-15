import { describe, expect, it } from "vitest";
import { isRepoAllowed, parseRepoAclAllowlist } from "./repo-acl";

describe("parseRepoAclAllowlist", () => {
  it("returns an empty allowlist for undefined or blank input", () => {
    expect(parseRepoAclAllowlist(undefined)).toEqual([]);
    expect(parseRepoAclAllowlist("")).toEqual([]);
    expect(parseRepoAclAllowlist("  ,  ")).toEqual([]);
  });

  it("parses comma-separated entries and trims whitespace", () => {
    expect(parseRepoAclAllowlist("acme/api, acme/web ,other/docs")).toEqual([
      { owner: "acme", name: "api" },
      { owner: "acme", name: "web" },
      { owner: "other", name: "docs" },
    ]);
  });

  it("maps a bare * to every repository", () => {
    expect(parseRepoAclAllowlist("*")).toEqual([{ owner: "*", name: "*" }]);
  });

  it("splits nested owners on the last slash", () => {
    expect(parseRepoAclAllowlist("group/sub/*")).toEqual([{ owner: "group/sub", name: "*" }]);
  });

  it("lowercases entries for case-insensitive matching", () => {
    expect(parseRepoAclAllowlist("AcMe/API")).toEqual([{ owner: "acme", name: "api" }]);
  });

  it.each(["acme", "/api", "acme/", " acme , api "])(
    "throws on a malformed entry: %s",
    (raw) => {
      expect(() => parseRepoAclAllowlist(raw)).toThrow(/malformed/);
    }
  );
});

describe("isRepoAllowed", () => {
  const allowlist = parseRepoAclAllowlist("acme/api,acme/*,*/docs,group/sub/*");

  it("allows an exact entry", () => {
    expect(isRepoAllowed(allowlist, "acme", "api")).toBe(true);
  });

  it("allows any repo under a wildcarded owner", () => {
    expect(isRepoAllowed(allowlist, "acme", "anything-else")).toBe(true);
  });

  it("allows a wildcarded name under any owner", () => {
    expect(isRepoAllowed(allowlist, "other-org", "docs")).toBe(true);
  });

  it("allows nested-namespace wildcard matches", () => {
    expect(isRepoAllowed(allowlist, "group/sub", "repo")).toBe(true);
  });

  it("denies repos outside the allowlist", () => {
    expect(isRepoAllowed(allowlist, "other-org", "api")).toBe(false);
    expect(isRepoAllowed(allowlist, "group/other", "repo")).toBe(false);
  });

  it("matches case-insensitively", () => {
    expect(isRepoAllowed(allowlist, "ACME", "API")).toBe(true);
  });

  it("denies everything against an empty allowlist", () => {
    expect(isRepoAllowed([], "acme", "api")).toBe(false);
  });

  it("allows everything with a bare * entry", () => {
    expect(isRepoAllowed(parseRepoAclAllowlist("*"), "any", "repo")).toBe(true);
  });
});
