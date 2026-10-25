import { describe, expect, it } from "vitest";
import { teamlessPublicationGate } from "./teamless-publication-gate";

describe("teamlessPublicationGate", () => {
  it("fails closed when the authoritative session is missing", () => {
    expect(teamlessPublicationGate(null)).toBe("missing_session");
  });

  it.each([
    { visibility: "workspace", ownerTeamId: null, reason: null },
    { visibility: "workspace", ownerTeamId: "team-a", reason: "team_owned_session" },
    { visibility: "team", ownerTeamId: null, reason: "non_workspace_session" },
    { visibility: "team", ownerTeamId: "team-a", reason: "non_workspace_session" },
    { visibility: "private", ownerTeamId: null, reason: "private_session" },
    { visibility: "private", ownerTeamId: "team-a", reason: "private_session" },
  ] as const)(
    "requires teamless workspace publication: %j",
    ({ visibility, ownerTeamId, reason }) => {
      expect(teamlessPublicationGate({ visibility, ownerTeamId })).toBe(reason);
    }
  );
});
