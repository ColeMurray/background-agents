import { describe, expect, it } from "vitest";
import {
  SETTINGS_GROUPS,
  canViewSettingsCategory,
  getSettingsPanel,
  type SettingsCategory,
} from "./settings-registry";

describe("settings registry", () => {
  it("registers every category exactly once with a panel and explicit visibility", () => {
    const categories: string[] = [];

    for (const group of SETTINGS_GROUPS) {
      for (const item of group.items) {
        categories.push(item.id);
        expect(getSettingsPanel(item.id)).toBe(item.panel);
        expect("public" in item.visibility || "anyOf" in item.visibility).toBe(true);
        expect("public" in item.visibility && "anyOf" in item.visibility).toBe(false);
      }
    }
    expect(new Set(categories).size).toBe(categories.length);
  });

  it.each([
    [["global_secrets.manage"], true],
    [["repositories.secrets.manage"], false],
    [["repositories.read"], false],
    [["repositories.secrets.manage", "repositories.read"], true],
    [["integrations.read"], false],
  ] as const)("resolves secrets visibility for %s", (permissions, expected) => {
    expect(
      canViewSettingsCategory("secrets", (candidate) => permissions.some((p) => p === candidate))
    ).toBe(expected);
  });

  it("keeps public categories independent of permissions", () => {
    const publicCategories: SettingsCategory[] = ["appearance", "keyboard-shortcuts"];

    for (const category of publicCategories) {
      expect(canViewSettingsCategory(category, () => false)).toBe(true);
    }
  });
});
