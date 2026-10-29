import { describe, expect, expectTypeOf, it } from "vitest";
import type { TeamAdmissionNeed, TeamAdmissionRequirement } from "../routing/team-admission";
import { requireAll, requireTeam } from "./shared";

describe("team admission requirements", () => {
  it("excludes presentation capabilities from requireTeam", () => {
    expectTypeOf<Parameters<typeof requireTeam>[0]>().toEqualTypeOf<
      Exclude<TeamAdmissionNeed, "removeMember">
    >();

    // @ts-expect-error Presentation grants are not route authorization needs.
    requireTeam("canReadTeamSessions");
    // @ts-expect-error Presentation grants are not route authorization needs.
    requireTeam("canReadTeamRepositories");
    // @ts-expect-error Presentation grants are not route authorization needs.
    requireTeam("canReadTeamEnvironments");
    // @ts-expect-error Presentation grants are not route authorization needs.
    requireTeam("canReadAutomations");
  });

  it("requires a target path parameter when removing a member", () => {
    const requirement = {
      kind: "team",
      teamIdParam: "id",
      need: "removeMember",
      targetUserIdParam: "userId",
    } as const satisfies TeamAdmissionRequirement;
    expect(requireAll(requirement).allOf).toEqual([requirement]);

    // @ts-expect-error requireTeam cannot express the required target path parameter.
    requireTeam("removeMember");
    // @ts-expect-error Removing a member must name the target path parameter.
    requireAll({ kind: "team", teamIdParam: "id", need: "removeMember" });
  });

  it("keeps read admission quiet and mutation admission audited", () => {
    expect(requireTeam("read").auditAllowed).toBe(false);
    expect(requireTeam("member").auditAllowed).toBe(false);
    expect(requireTeam("canManageMembers").auditAllowed).toBe(true);
    expect(requireTeam("canJoin").auditAllowed).toBe(true);
    expect(requireTeam("canArchive", { auditAllowed: false }).auditAllowed).toBe(false);
  });
});
