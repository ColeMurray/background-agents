import { describe, expect, it } from "vitest";
import { resolveComposerAccess, type ComposerAccessDraft } from "./composer-access";

const context = {
  activeTeamId: null,
  scope: undefined,
  requireTeamOnCreate: false,
  teams: [{ id: "team_one", defaultVisibility: "team" as const }],
};

describe("composer access", () => {
  it("defaults aggregate contexts to a teamless workspace draft", () => {
    expect(resolveComposerAccess(context, null)).toEqual({
      contextKey: "all-my-teams",
      teamId: null,
      visibility: "workspace",
    });
  });

  it("uses the active team or first required team's defaults", () => {
    for (const input of [
      { ...context, activeTeamId: "team_one" },
      { ...context, requireTeamOnCreate: true },
    ]) {
      expect(resolveComposerAccess(input, null)).toMatchObject({
        teamId: "team_one",
        visibility: "team",
      });
    }
  });

  it("preserves a valid draft without allocating another state object", () => {
    const draft: ComposerAccessDraft = {
      contextKey: "all-my-teams",
      teamId: "team_one",
      visibility: "private",
    };
    expect(resolveComposerAccess(context, draft)).toBe(draft);
  });

  it("preselects a newly required team without widening the draft's audience", () => {
    const draft: ComposerAccessDraft = {
      contextKey: "all-my-teams",
      teamId: null,
      visibility: "private",
    };
    expect(resolveComposerAccess({ ...context, requireTeamOnCreate: true }, draft)).toEqual({
      ...draft,
      teamId: "team_one",
    });
  });

  it("removes unavailable teams and never resolves team visibility without a team", () => {
    const draft: ComposerAccessDraft = {
      contextKey: "all-my-teams",
      teamId: "team_old",
      visibility: "team",
    };
    expect(resolveComposerAccess(context, draft)).toMatchObject({
      teamId: null,
      visibility: "workspace",
    });
    expect(
      resolveComposerAccess({ ...context, teams: [], requireTeamOnCreate: true }, draft)
    ).toMatchObject({ teamId: null, visibility: "workspace" });
  });

  it.each(["workspace", "all"] as const)(
    "discards a local draft on aggregate scope change to %s",
    (scope) => {
      const draft: ComposerAccessDraft = {
        contextKey: "all-my-teams",
        teamId: "team_one",
        visibility: "private",
      };
      expect(resolveComposerAccess({ ...context, scope }, draft)).toEqual({
        contextKey: scope,
        teamId: null,
        visibility: "workspace",
      });
    }
  );
});
