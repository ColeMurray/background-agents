import { describe, expect, it } from "vitest";
import { ME_TEAMS_API_PATH, isMeTeamsCacheKey, meTeamsKey } from "./me-teams-cache";

describe("membership cache keys", () => {
  it("keys memberships by endpoint and user identity", () => {
    expect(ME_TEAMS_API_PATH).toBe("/api/me/teams");
    expect(meTeamsKey("user_one")).toEqual([ME_TEAMS_API_PATH, "user_one"]);
    expect(meTeamsKey("user_two")).not.toEqual(meTeamsKey("user_one"));
    expect(isMeTeamsCacheKey(meTeamsKey("user_one"))).toBe(true);
    expect(isMeTeamsCacheKey(meTeamsKey("user_two"))).toBe(true);
  });

  it.each([
    [undefined],
    [null],
    [ME_TEAMS_API_PATH],
    ["/api/me/teams?membership=all"],
    [[ME_TEAMS_API_PATH]],
    [[ME_TEAMS_API_PATH, null]],
    [[ME_TEAMS_API_PATH, 1]],
    [[ME_TEAMS_API_PATH, "user_one", "extra"]],
    [["/api/teams", "user_one"]],
    [{ 0: ME_TEAMS_API_PATH, 1: "user_one", length: 2 }],
  ])("does not match unrelated or malformed key %j", (key) => {
    expect(isMeTeamsCacheKey(key)).toBe(false);
  });
});
