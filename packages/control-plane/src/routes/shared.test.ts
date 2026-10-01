import { describe, expect, it } from "vitest";
import type { TeamCapabilities } from "@open-inspect/shared/types/team-access";
import { permissionRequirement, requireAll, requireTeam } from "./shared";

describe("team audit defaults", () => {
  it.each<keyof TeamCapabilities | "read" | "member">([
    "read",
    "member",
    "canEditMetadata",
    "canManageMembers",
  ])("classifies %s identically standalone and in a composition", (need) => {
    const expected = need !== "read" && need !== "member";
    expect(requireTeam(need).auditAllowed).toBe(expected);
    expect(
      requireAll({ kind: "team", teamIdParam: "id", need }, permissionRequirement("sessions.read"))
        .auditAllowed
    ).toBe(expected);
  });

  it("still audits a composition with a write permission", () => {
    expect(
      requireAll(
        { kind: "team", teamIdParam: "id", need: "member" },
        permissionRequirement("sessions.create")
      ).auditAllowed
    ).toBe(true);
  });

  it("preserves explicit audit overrides", () => {
    expect(requireTeam("member", { auditAllowed: true }).auditAllowed).toBe(true);
    expect(requireTeam("canManageRepositories", { auditAllowed: false }).auditAllowed).toBe(false);
  });
});
