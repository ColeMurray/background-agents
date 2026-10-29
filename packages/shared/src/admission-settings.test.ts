import { describe, expect, it } from "vitest";
import {
  admissionPolicySnapshotSchema,
  admissionRulesSchema,
  emptyAdmissionRules,
  MAX_MANAGED_ADMISSION_RULES,
  mergeAdmissionRules,
  parseStoredAdmissionPolicy,
} from "./admission-settings";

describe("admission settings contracts", () => {
  const stored = {
    schema_version: 1,
    revision: 7,
    rules_json: JSON.stringify(emptyAdmissionRules()),
    updated_at: 10,
    updated_by_user_id_snapshot: "editor",
  };

  it("parses the complete persisted envelope while preserving raw JSON for CAS", () => {
    const rulesJson = JSON.stringify(
      { ...emptyAdmissionRules(), allowedGitHubUsers: [" Alice ", "alice"] },
      null,
      2
    );
    expect(parseStoredAdmissionPolicy({ ...stored, rules_json: rulesJson })).toEqual({
      rules: { ...emptyAdmissionRules(), allowedGitHubUsers: ["alice"] },
      rulesJson,
      revision: 7,
      updatedAt: 10,
      updatedByUserId: "editor",
    });
  });

  it.each([
    { schema_version: 2 },
    { revision: -1 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { rules_json: "broken" },
    { rules_json: "{}" },
    { rules_json: JSON.stringify({ ...emptyAdmissionRules(), allowedEmails: ["bad"] }) },
    { updated_at: -1 },
    { updated_at: 1.5 },
    { updated_at: "10" },
    { updated_at: undefined },
    { updated_at: Number.MAX_SAFE_INTEGER + 1 },
    { updated_by_user_id_snapshot: "" },
    { updated_by_user_id_snapshot: 10 },
    { updated_by_user_id_snapshot: undefined },
  ])("rejects invalid persisted fields %j", (invalid) => {
    expect(() => parseStoredAdmissionPolicy({ ...stored, ...invalid })).toThrow();
  });

  it("normalizes, deduplicates, and sorts each managed list independently", () => {
    expect(
      admissionRulesSchema.parse({
        allowedGitHubUsers: [" Zebra ", "alice", "ALICE"],
        allowedEmails: [" First.Last+Tag@Example.COM "],
        allowedEmailDomains: [" XN--BCHER-KVA.example "],
        allowedGitHubOrganizations: ["TEAM", "team"],
      })
    ).toEqual({
      allowedGitHubUsers: ["alice", "zebra"],
      allowedEmails: ["first.last+tag@example.com"],
      allowedEmailDomains: ["xn--bcher-kva.example"],
      allowedGitHubOrganizations: ["team"],
    });
  });

  it.each([
    ["allowedGitHubUsers", ""],
    ["allowedGitHubUsers", "@alice"],
    ["allowedGitHubUsers", "a--b"],
    ["allowedGitHubUsers", "-alice"],
    ["allowedGitHubUsers", "alice-"],
    ["allowedGitHubUsers", "a".repeat(40)],
    ["allowedGitHubOrganizations", "https://github.com/team"],
    ["allowedGitHubOrganizations", "one,two"],
    ["allowedEmails", "A Person <a@example.com>"],
    ["allowedEmails", "a@example.com,b@example.com"],
    ["allowedEmails", "a..b@example.com"],
    ["allowedEmails", "a@localhost"],
    ["allowedEmails", "a@127.0.0.1"],
    ["allowedEmails", "\u00e9@example.com"],
    ["allowedEmails", "\ta@example.com"],
    ["allowedEmails", "a@example.com\n"],
    ["allowedEmailDomains", "example"],
    ["allowedEmailDomains", "*.example.com"],
    ["allowedEmailDomains", "example.com."],
    ["allowedEmailDomains", "https://example.com"],
    ["allowedEmailDomains", "example.com:443"],
    ["allowedEmailDomains", "a@example.com"],
    ["allowedEmailDomains", "127.0.0.1"],
    ["allowedEmailDomains", "[::1]"],
    ["allowedEmailDomains", "b\u00fccher.example"],
    ["allowedEmailDomains", "-bad.example"],
    ["allowedEmailDomains", `${"a".repeat(64)}.example`],
    [
      "allowedEmailDomains",
      `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}`,
    ],
  ])("rejects invalid %s value %s", (field, value) => {
    expect(
      admissionRulesSchema.safeParse({ ...emptyAdmissionRules(), [field]: [value] }).success
    ).toBe(false);
  });

  it("requires exactly the four string-array fields", () => {
    expect(admissionRulesSchema.safeParse({}).success).toBe(false);
    expect(
      admissionRulesSchema.safeParse({ ...emptyAdmissionRules(), unsafeAllowAllUsers: true })
        .success
    ).toBe(false);
    expect(
      admissionRulesSchema.safeParse({ ...emptyAdmissionRules(), allowedEmails: [123] }).success
    ).toBe(false);
  });

  it("accepts explicit punycode email domains without Unicode case folding", () => {
    const rules = { ...emptyAdmissionRules(), allowedEmails: ["A@XN--BCHER-KVA.XN--P1AI"] };
    expect(admissionRulesSchema.parse(rules).allowedEmails).toEqual(["a@xn--bcher-kva.xn--p1ai"]);
    expect(
      admissionRulesSchema.safeParse({ ...rules, allowedEmails: ["\u212a@example.com"] }).success
    ).toBe(false);
  });

  it("bounds email length at 254 characters", () => {
    const domain = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(61)}`;
    const email = `${"a".repeat(64)}@${domain}`;
    expect(email.length).toBe(254);
    expect(
      admissionRulesSchema.safeParse({ ...emptyAdmissionRules(), allowedEmails: [email] }).success
    ).toBe(true);
    expect(
      admissionRulesSchema.safeParse({ ...emptyAdmissionRules(), allowedEmails: [`a${email}`] })
        .success
    ).toBe(false);
  });

  it("bounds normalized distinct rules globally and organizations separately", () => {
    const rules = {
      ...emptyAdmissionRules(),
      allowedGitHubUsers: Array.from(
        { length: MAX_MANAGED_ADMISSION_RULES },
        (_, i) => `user-${i}`
      ),
    };
    expect(admissionRulesSchema.safeParse(rules).success).toBe(true);
    expect(
      admissionRulesSchema.safeParse({ ...rules, allowedEmails: ["a@example.com"] }).success
    ).toBe(false);
    expect(
      admissionRulesSchema.safeParse({
        ...rules,
        allowedGitHubUsers: [...rules.allowedGitHubUsers, " USER-0 "],
      }).success
    ).toBe(true);
    expect(
      admissionRulesSchema.safeParse({
        ...emptyAdmissionRules(),
        allowedGitHubOrganizations: Array.from({ length: 11 }, (_, i) => `org-${i}`),
      }).success
    ).toBe(false);
  });

  it("unions without mutating either source or reordering deployment organizations", () => {
    const deployment = {
      ...emptyAdmissionRules(),
      allowedGitHubOrganizations: [" Z-Team ", "a-team"],
      allowedEmails: ["A@EXAMPLE.COM"],
    };
    const managed = {
      ...emptyAdmissionRules(),
      allowedGitHubOrganizations: ["a-team", "b-team"],
      allowedEmails: ["a@example.com"],
    };
    const merged = mergeAdmissionRules(deployment, managed);
    expect(merged.allowedGitHubOrganizations).toEqual(["z-team", "a-team", "b-team"]);
    expect(merged.allowedEmails).toEqual(["a@example.com"]);
    expect(managed.allowedEmails).toEqual(["a@example.com"]);
    expect(deployment.allowedEmails).toEqual(["A@EXAMPLE.COM"]);
    expect(mergeAdmissionRules(deployment, emptyAdmissionRules()).allowedEmails).toEqual([
      "a@example.com",
    ]);
  });

  it("accepts unusual legacy deployment syntax in strict snapshots without weakening managed rules", () => {
    const deployment = {
      ...emptyAdmissionRules(),
      allowedEmailDomains: [" LOCALHOST ", "localhost"],
      allowedGitHubOrganizations: Array.from({ length: 15 }, (_, i) => `legacy_${i}`),
    };
    const snapshot = {
      deployment,
      managed: emptyAdmissionRules(),
      effective: deployment,
      revision: 0,
      etag: '"token"',
      updatedAt: null,
      updatedByUserId: null,
      enabledProviders: ["github"],
      unsafeAllowAllUsers: false,
      unsafeAllowAllEffective: false,
      editingDisabledReason: null,
    };
    expect(admissionPolicySnapshotSchema.parse(snapshot).deployment.allowedEmailDomains).toEqual([
      "localhost",
    ]);
    expect(
      admissionPolicySnapshotSchema.safeParse({ ...snapshot, managed: deployment }).success
    ).toBe(false);
    expect(admissionPolicySnapshotSchema.safeParse({ ...snapshot, secret: "no" }).success).toBe(
      false
    );
  });
});
