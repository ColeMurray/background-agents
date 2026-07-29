import { describe, expect, it } from "vitest";
import { buildAuthDisplay } from "./build-auth-identity";

describe("buildAuthDisplay", () => {
  it("returns cosmetic fields without identity or SCM assertions", () => {
    expect(
      buildAuthDisplay({
        name: "Ada Lovelace",
        email: "ada@example.com",
        image: "https://avatars.example/ada",
      })
    ).toEqual({
      actorEmail: "ada@example.com",
      actorDisplayName: "Ada Lovelace",
      actorAvatarUrl: "https://avatars.example/ada",
    });
  });

  it("normalizes null fields to undefined", () => {
    expect(buildAuthDisplay({ name: null, email: null, image: null })).toEqual({
      actorEmail: undefined,
      actorDisplayName: undefined,
      actorAvatarUrl: undefined,
    });
  });
});
