import { describe, expect, it } from "vitest";
import { automationNavigation, automationScopeTeamId } from "./automation-navigation";

describe("automation navigation", () => {
  it.each([undefined, null, ""])("retains shipped unscoped links for %s", (teamId) => {
    const navigation = automationNavigation(teamId);
    expect(navigation.list).toBe("/automations");
    expect(navigation.detail("auto-1")).toBe("/automations/auto-1");
    expect(navigation.edit("auto-1")).toBe("/automations/auto-1/edit");
    expect(navigation.templates).toBe("/automations/templates");
    expect(navigation.new()).toBe("/automations/new");
    expect(navigation.new("find-bugs")).toBe("/automations/new?template=find-bugs");
  });

  it("roundtrips team scope through every internal destination", () => {
    const teamId = "team/one & two";
    const navigation = automationNavigation(teamId);
    const links = [
      navigation.list,
      navigation.detail("auto-1"),
      navigation.edit("auto-1"),
      navigation.templates,
      navigation.new(),
      navigation.new("find-bugs"),
    ];
    for (const link of links) {
      const url = new URL(link, "https://example.com");
      expect(url.pathname.startsWith("/automations")).toBe(true);
      expect(url.searchParams.get("teamId")).toBe(teamId);
      expect(automationNavigation(url.searchParams.get("teamId")).list).toBe(navigation.list);
    }
  });

  it.each([undefined, "team/one & two"])(
    "encodes reserved ID characters with scope %s",
    (teamId) => {
      const id = "auto/one?next=other#section%2F";
      const navigation = automationNavigation(teamId);
      const scope = teamId ? "?teamId=team%2Fone%20%26%20two" : "";
      expect(navigation.detail(id)).toBe(
        `/automations/auto%2Fone%3Fnext%3Dother%23section%252F${scope}`
      );
      expect(navigation.edit(id)).toBe(
        `/automations/auto%2Fone%3Fnext%3Dother%23section%252F/edit${scope}`
      );
      for (const link of [navigation.detail(id), navigation.edit(id)]) {
        const url = new URL(link, "https://example.com");
        expect(decodeURIComponent(url.pathname.split("/")[2])).toBe(id);
        expect(url.searchParams.get("teamId")).toBe(teamId ?? null);
        expect(url.searchParams.get("next")).toBeNull();
        expect(url.hash).toBe("");
      }
    }
  );
});

describe("automationScopeTeamId", () => {
  it.each([
    [null, undefined],
    ["", undefined],
    ["null", undefined],
    ["team_a", "team_a"],
  ])("maps %j to %j", (value, scope) => {
    expect(automationScopeTeamId(value)).toBe(scope);
  });
});
