import { describe, expect, it } from "vitest";
import { slackPostGate } from "./slack-post-gate";

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

  it.each(["team", "workspace"] as const)(
    "refuses team-owned %s-visible sessions targeting an unbound channel",
    (visibility) => {
      expect(slackPostGate({ ownerTeamId: "team-a", visibility }, null)).toBe(
        "channel_team_mismatch"
      );
    }
  );

  it("allows a workspace-owned session targeting an unbound channel", () => {
    expect(slackPostGate({ ownerTeamId: null, visibility: "workspace" }, null)).toBeNull();
  });
});
