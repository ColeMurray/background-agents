import { describe, expect, it } from "vitest";
import { updateTeamRequestSchema } from "./teams";

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
