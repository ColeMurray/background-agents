import { describe, expect, it } from "vitest";
import { automationNavigation } from "./automation-navigation";

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
});
