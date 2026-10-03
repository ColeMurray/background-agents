import { describe, expect, it } from "vitest";
import { slackPostGate, type SlackPostSession } from "./slack-post-gate";

describe("slackPostGate", () => {
  it("refuses a missing session even for an unbound channel", () => {
    expect(slackPostGate(null, null)).toBe("missing_session");
  });

  it.each([null, { teamId: "team-a" }, { teamId: "team-b" }])(
    "refuses private sessions regardless of binding %j",
    (binding) => {
      expect(slackPostGate({ ownerTeamId: "team-a", visibility: "private" }, binding)).toBe(
        "private_session"
      );
    }
  );

  it.each(["team", "workspace"] as const)(
    "refuses cross-team publication for %s-visible sessions",
    (visibility) => {
      expect(slackPostGate({ ownerTeamId: "team-a", visibility }, { teamId: "team-b" })).toBe(
        "channel_team_mismatch"
      );
    }
  );

  it("refuses an ownerless session targeting a bound channel", () => {
    expect(
      slackPostGate({ ownerTeamId: null, visibility: "workspace" }, { teamId: "team-a" })
    ).toBe("channel_team_mismatch");
  });

  it.each(["team", "workspace"] as const)(
    "allows matching-team publication for %s-visible sessions",
    (visibility) => {
      expect(slackPostGate({ ownerTeamId: "team-a", visibility }, { teamId: "team-a" })).toBeNull();
    }
  );

  it.each([
    { ownerTeamId: "team-a", visibility: "team" },
    { ownerTeamId: "team-a", visibility: "workspace" },
    { ownerTeamId: null, visibility: "workspace" },
  ] satisfies SlackPostSession[])("allows an unbound channel for %j", (session) => {
    expect(slackPostGate(session, null)).toBeNull();
  });
});
