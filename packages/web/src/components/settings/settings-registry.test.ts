import { describe, expect, it } from "vitest";
import { canViewSettingsCategory } from "./settings-registry";

describe("settings registry", () => {
  it("shows Access Tokens without any workspace permission", () => {
    expect(canViewSettingsCategory("access-tokens", () => false)).toBe(true);
  });
});
