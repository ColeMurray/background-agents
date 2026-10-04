import { describe, expect, it } from "vitest";
import { createSessionRequestSchema } from "./session-api";
import {
  createTeamRequestSchema,
  sessionVisibilitySchema,
  teamDefaultVisibilitySchema,
  teamResponseSchema,
  teamRowSchema,
  updateTeamRequestSchema,
} from "./teams";

describe("team default visibility", () => {
  it.each(["team", "workspace"])(
    "accepts %s in every team default contract",
    (defaultVisibility) => {
      expect(teamDefaultVisibilitySchema.parse(defaultVisibility)).toBe(defaultVisibility);
      expect(
        createTeamRequestSchema.parse({
          slug: "engineering",
          name: "Engineering",
          defaultVisibility,
        })
      ).toMatchObject({ defaultVisibility });
      expect(updateTeamRequestSchema.parse({ defaultVisibility })).toEqual({ defaultVisibility });
      expect(teamRowSchema.shape.default_visibility.parse(defaultVisibility)).toBe(
        defaultVisibility
      );
      expect(teamResponseSchema.shape.defaultVisibility.parse(defaultVisibility)).toBe(
        defaultVisibility
      );
    }
  );

  it("rejects private in every team default contract", () => {
    expect(teamDefaultVisibilitySchema.safeParse("private").success).toBe(false);
    expect(
      createTeamRequestSchema.safeParse({
        slug: "engineering",
        name: "Engineering",
        defaultVisibility: "private",
      }).success
    ).toBe(false);
    expect(updateTeamRequestSchema.safeParse({ defaultVisibility: "private" }).success).toBe(false);
    expect(teamRowSchema.shape.default_visibility.safeParse("private").success).toBe(false);
    expect(teamResponseSchema.shape.defaultVisibility.safeParse("private").success).toBe(false);
  });

  it.each(["team", "workspace", "private"])(
    "preserves explicit %s session visibility",
    (visibility) => {
      expect(sessionVisibilitySchema.parse(visibility)).toBe(visibility);
      expect(createSessionRequestSchema.parse({ teamId: "team_one", visibility })).toMatchObject({
        teamId: "team_one",
        visibility,
      });
    }
  );
});
