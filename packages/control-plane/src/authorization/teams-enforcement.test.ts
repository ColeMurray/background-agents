import { describe, expect, it } from "vitest";
import { SESSION_ACTIONS } from "@open-inspect/shared";
import { legacyPermissionForAction, parseTeamsEnforcementMode } from "./teams-enforcement";

describe("teams enforcement", () => {
  it("defaults to shadow and accepts only the three modes", () => {
    expect(parseTeamsEnforcementMode(undefined)).toBe("shadow");
    expect(parseTeamsEnforcementMode("off")).toBe("off");
    expect(parseTeamsEnforcementMode("shadow")).toBe("shadow");
    expect(parseTeamsEnforcementMode("on")).toBe("on");
    expect(() => parseTeamsEnforcementMode("enabled")).toThrow();
  });

  it("maps every resolver action to its pre-enforcement permission", () => {
    expect(SESSION_ACTIONS.map((action) => legacyPermissionForAction(action))).toEqual([
      "sessions.read",
      "sessions.collaborate",
      "sessions.lifecycle",
      "sessions.delete",
      "sessions.sandbox_access",
      "sessions.lifecycle",
      "sessions.lifecycle",
      "sessions.lifecycle",
    ]);
  });
});
