import { USER_MERGE_COUNT_KEYS, type UserMergeCountKey } from "@open-inspect/shared/rbac";
import { describe, expect, it } from "vitest";
import { describeIdentity, summarizeMergeCounts } from "./member-merge-summary";

function counts(nonZero: Partial<Record<UserMergeCountKey, number>>) {
  return {
    ...(Object.fromEntries(USER_MERGE_COUNT_KEYS.map((key) => [key, 0])) as Record<
      UserMergeCountKey,
      number
    >),
    ...nonZero,
  };
}

describe("summarizeMergeCounts", () => {
  it("lists moved records and totals reattributed records and exact duplicates", () => {
    expect(
      summarizeMergeCounts(
        counts({
          identitiesRepointed: 1,
          sessionsRepointed: 3,
          memoriesOwnedRepointed: 1,
          automationsCreatedRepointed: 2,
          skillsCreatedRepointed: 1,
          readStatesDeduped: 4,
          identitiesDeduped: 1,
          authSessionsDeleted: 2,
          auditEventsCreated: 1,
          usersDeleted: 1,
          roleAssignmentsRemoved: 1,
        })
      )
    ).toEqual({
      moves: ["1 linked sign-in", "3 sessions", "1 memory"],
      otherRecords: 3,
      teamLeadPromotions: 0,
      combinedSkillProfiles: 0,
      replacedSettings: [],
      duplicates: 5,
      endedSignIns: 2,
      emailCarriedOver: false,
    });
  });

  it("reports team lead promotion as an access change, not a skipped duplicate", () => {
    expect(
      summarizeMergeCounts(counts({ teamLeadRolesPromoted: 1, teamMembershipsDeduped: 1 }))
    ).toMatchObject({ teamLeadPromotions: 1, duplicates: 1 });
  });

  it("separates combined skill profiles and discarded settings from duplicates", () => {
    expect(
      summarizeMergeCounts(
        counts({
          skillProfilesDeduped: 2,
          skillProfileItemsMerged: 5,
          memoryPreferencesDeduped: 1,
          keyboardShortcutPreferencesDeduped: 1,
        })
      )
    ).toMatchObject({
      combinedSkillProfiles: 2,
      replacedSettings: ["memory preferences", "keyboard shortcuts"],
      duplicates: 0,
      otherRecords: 0,
    });
  });

  it("reports an email carried over to an email-less kept account", () => {
    expect(summarizeMergeCounts(counts({ canonicalEmailBackfilled: 1 }))).toMatchObject({
      moves: [],
      otherRecords: 0,
      emailCarriedOver: true,
    });
  });
});

describe("describeIdentity", () => {
  it("names known providers and prefers the login over the email", () => {
    expect(describeIdentity({ provider: "github", login: "octocat", email: "o@example.com" })).toBe(
      "GitHub · octocat"
    );
    expect(describeIdentity({ provider: "slack", login: null, email: "o@corp.example" })).toBe(
      "Slack · o@corp.example"
    );
    expect(describeIdentity({ provider: "custom-idp", login: null, email: null })).toBe(
      "custom-idp"
    );
  });
});
