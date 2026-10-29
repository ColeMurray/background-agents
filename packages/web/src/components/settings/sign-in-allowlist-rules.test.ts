import { describe, expect, it } from "vitest";
import {
  admissionRulesSchema,
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
    ["  Person@Example.com ", [{ type: "allowedEmails", value: "  Person@Example.com " }]],
    ["example.com", [{ type: "allowedEmailDomains", value: "example.com" }]],
    [" @Example.com", [{ type: "allowedEmailDomains", value: " Example.com" }]],
    [
      "OctoCat",
      [
        { type: "allowedGitHubUsers", value: "OctoCat" },
        { type: "allowedGitHubOrganizations", value: "OctoCat" },
      ],
    ],
    [
      " https://www.GitHub.com/My-Org/ ",
      [
        { type: "allowedGitHubUsers", value: "My-Org" },
        { type: "allowedGitHubOrganizations", value: "My-Org" },
      ],
    ],
    [
      "https://github.com/orgs/Acme-Inc/",
      [{ type: "allowedGitHubOrganizations", value: "Acme-Inc" }],
    ],
  ])("interprets %j", (input, expected) => {
    expect(detectRuleTypes(input)).toEqual(expected);
  });
});

describe("detectRuleTypes with admissionRulesSchema", () => {
  /** Adds the first candidate the way the editor does and returns the saved rule, if valid. */
  function save(input: string) {
    const [candidate] = detectRuleTypes(input);
    const parsed = admissionRulesSchema.safeParse({
      ...emptyAdmissionRules(),
      [candidate.type]: [candidate.value],
    });
    return parsed.success ? { [candidate.type]: parsed.data[candidate.type] } : null;
  }

  it.each([
    ["github.com/alice@example.com", { allowedEmails: ["github.com/alice@example.com"] }],
    ["www.github.com/alice@example.com", { allowedEmails: ["www.github.com/alice@example.com"] }],
    [" NEW@Example.com ", { allowedEmails: ["new@example.com"] }],
    [" @EXAMPLE.com ", { allowedEmailDomains: ["example.com"] }],
    ["https://github.com/My-Org/", { allowedGitHubUsers: ["my-org"] }],
    ["github.com/orgs/Acme-Inc", { allowedGitHubOrganizations: ["acme-inc"] }],
  ])("saves %j as the schema normalizes it", (input, expected) => {
    expect(save(input)).toEqual(expected);
  });

  it.each([
    "\u212a@example.com",
    "\u212aorp.com",
    "\talice@example.com",
    "alice@example.com\n",
    "\tgithub.com/alice",
  ])("leaves %j for the schema to reject", (input) => {
    expect(save(input)).toBeNull();
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
