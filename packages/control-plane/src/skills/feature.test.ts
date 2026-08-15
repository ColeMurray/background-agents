import { describe, expect, it } from "vitest";
import { managedSkillsEnabled } from "./feature";

describe("managedSkillsEnabled", () => {
  it("defaults enabled and honors the emergency kill switch", () => {
    expect(managedSkillsEnabled({})).toBe(true);
    expect(managedSkillsEnabled({ MANAGED_SKILLS_ENABLED: "true" })).toBe(true);
    expect(managedSkillsEnabled({ MANAGED_SKILLS_ENABLED: "false" })).toBe(false);
  });
});
