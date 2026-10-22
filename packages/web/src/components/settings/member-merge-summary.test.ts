import { describe, expect, it } from "vitest";
import { describeIdentity, summarizeMergeCounts } from "./member-merge-summary";

describe("summarizeMergeCounts", () => {
  it("lists recognizable records and folds the rest into other, duplicate, and sign-in totals", () => {
    expect(
      summarizeMergeCounts({
        identitiesRepointed: 1,
        sessionsRepointed: 3,
        automationsOwnedRepointed: 0,
        memoriesOwnedRepointed: 1,
        automationsCreatedRepointed: 2,
        skillsCreatedRepointed: 1,
        readStatesDeduped: 4,
        identitiesDeduped: 1,
        authSessionsDeleted: 2,
        auditEventsCreated: 1,
        usersDeleted: 1,
        roleAssignmentsRemoved: 1,
        canonicalEmailBackfilled: 0,
      })
    ).toEqual({
      moves: ["1 linked sign-in", "3 sessions", "1 memory"],
      otherRecords: 3,
      duplicates: 5,
      endedSignIns: 2,
      emailCarriedOver: false,
    });
  });

  it("reports an email carried over to an email-less kept account", () => {
    expect(summarizeMergeCounts({ canonicalEmailBackfilled: 1 })).toMatchObject({
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
