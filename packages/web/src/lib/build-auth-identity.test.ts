import { describe, expect, it } from "vitest";
import { buildAuthDisplay, isAuthProvider } from "./build-auth-identity";

describe("isAuthProvider", () => {
  it("accepts only executable sign-in providers", () => {
    expect(isAuthProvider("github")).toBe(true);
    expect(isAuthProvider("google")).toBe(true);
    expect(isAuthProvider("gitlab")).toBe(false);
    expect(isAuthProvider(undefined)).toBe(false);
  });
});

describe("buildAuthDisplay", () => {
  it("returns cosmetic fields without identity or SCM assertions", () => {
    expect(
      buildAuthDisplay({
        name: "Ada Lovelace",
        email: "ada@example.com",
        image: "https://avatars.example/ada",
      })
    ).toEqual({
      authEmail: "ada@example.com",
      authName: "Ada Lovelace",
      authAvatarUrl: "https://avatars.example/ada",
    });
  });

  it("normalizes null fields to undefined", () => {
    expect(buildAuthDisplay({ name: null, email: null, image: null })).toEqual({
      authEmail: undefined,
      authName: undefined,
      authAvatarUrl: undefined,
    });
  });
});
