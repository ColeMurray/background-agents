import { describe, expect, it } from "vitest";
import { isSignInProvider } from "./sign-in-provider";

describe("isSignInProvider", () => {
  it("accepts only executable browser sign-in providers", () => {
    expect(isSignInProvider("github")).toBe(true);
    expect(isSignInProvider("google")).toBe(true);
    expect(isSignInProvider("okta")).toBe(false);
    expect(isSignInProvider("slack")).toBe(false);
  });
});
