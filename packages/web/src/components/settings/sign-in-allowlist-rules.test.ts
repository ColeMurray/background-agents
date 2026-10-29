import { describe, expect, it } from "vitest";
import {
  emptyAdmissionRules,
  type AdmissionPolicySnapshot,
} from "@open-inspect/shared/admission-settings";
import { allowlistEntries, describeRule, detectRuleTypes } from "./sign-in-allowlist-rules";

const snapshot: AdmissionPolicySnapshot = {
  deployment: { ...emptyAdmissionRules(), allowedEmails: ["recovery@example.com"] },
  managed: {
    ...emptyAdmissionRules(),
    allowedEmails: ["kept@example.com", "removed@example.com"],
    allowedEmailDomains: ["example.com"],
  },
  effective: emptyAdmissionRules(),
  revision: 1,
  etag: '"policy-1"',
  updatedAt: null,
  updatedByUserId: null,
  enabledProviders: ["github", "google"],
  unsafeAllowAllUsers: false,
  unsafeAllowAllEffective: false,
  editingDisabledReason: null,
};

describe("detectRuleTypes", () => {
  it.each([
    ["", []],
    ["  Person@Example.com ", [{ type: "allowedEmails", value: "person@example.com" }]],
    ["example.com", [{ type: "allowedEmailDomains", value: "example.com" }]],
    ["@Example.com", [{ type: "allowedEmailDomains", value: "example.com" }]],
    [
      "OctoCat",
      [
        { type: "allowedGitHubUsers", value: "octocat" },
        { type: "allowedGitHubOrganizations", value: "octocat" },
      ],
    ],
    [
      "https://github.com/my-org/",
      [
        { type: "allowedGitHubUsers", value: "my-org" },
        { type: "allowedGitHubOrganizations", value: "my-org" },
      ],
    ],
  ])("interprets %j", (input, expected) => {
    expect(detectRuleTypes(input)).toEqual(expected);
  });
});

describe("describeRule", () => {
  it("describes each rule type in plain language", () => {
    expect(describeRule("allowedEmails", "a@example.com")).toBe("a@example.com");
    expect(describeRule("allowedEmailDomains", "example.com")).toBe(
      "Anyone with an @example.com email"
    );
    expect(describeRule("allowedGitHubUsers", "octocat")).toBe("octocat on GitHub");
    expect(describeRule("allowedGitHubOrganizations", "my-org")).toBe(
      "Members of my-org on GitHub"
    );
  });
});

describe("allowlistEntries", () => {
  it("marks pending edits and lists settings rules before deployment rules", () => {
    const entries = allowlistEntries(snapshot, {
      ...emptyAdmissionRules(),
      allowedEmails: ["kept@example.com", "new@example.com"],
      allowedEmailDomains: ["example.com"],
      allowedGitHubUsers: ["octocat"],
    });
    expect(
      entries.map(({ value, status, fromDeployment }) => [value, status, fromDeployment])
    ).toEqual([
      ["kept@example.com", "saved", false],
      ["new@example.com", "added", false],
      ["removed@example.com", "removed", false],
      ["octocat", "added", false],
      ["example.com", "saved", false],
      ["recovery@example.com", "saved", true],
    ]);
  });

  it("keeps a removed settings copy of a deployment rule granted", () => {
    const [entry] = allowlistEntries(
      {
        ...snapshot,
        managed: { ...emptyAdmissionRules(), allowedEmails: ["recovery@example.com"] },
      },
      emptyAdmissionRules()
    );
    expect(entry).toEqual({
      type: "allowedEmails",
      value: "recovery@example.com",
      fromDeployment: true,
      inDraft: false,
      status: "removed",
    });
  });
});
