import { describe, expect, it } from "vitest";
import { meTeamsResponseSchema, updateTeamRequestSchema } from "./teams";

describe("meTeamsResponseSchema", () => {
  it("defaults the omitted creation setting in legacy membership responses", () => {
    expect(meTeamsResponseSchema.parse({ teams: [] })).toEqual({
      teams: [],
      requireTeamOnCreate: false,
    });
  });

  it.each([false, true])("preserves the explicit creation setting %s", (requireTeamOnCreate) => {
    expect(meTeamsResponseSchema.parse({ teams: [], requireTeamOnCreate })).toEqual({
      teams: [],
      requireTeamOnCreate,
    });
  });

  it.each([null, "false", "true", 0, 1])(
    "rejects an invalid creation setting %j",
    (requireTeamOnCreate) => {
      expect(meTeamsResponseSchema.safeParse({ teams: [], requireTeamOnCreate }).success).toBe(
        false
      );
    }
  );
});

describe("updateTeamRequestSchema", () => {
  it("accepts a canonical environment ID or null, but not an empty or malformed ID", () => {
    expect(updateTeamRequestSchema.safeParse({ defaultEnvironmentId: "env_valid-1" }).success).toBe(
      true
    );
    expect(updateTeamRequestSchema.safeParse({ defaultEnvironmentId: null }).success).toBe(true);
    for (const defaultEnvironmentId of ["", "some-name", "env_invalid/id"]) {
      expect(updateTeamRequestSchema.safeParse({ defaultEnvironmentId }).success).toBe(false);
    }
  });
});
