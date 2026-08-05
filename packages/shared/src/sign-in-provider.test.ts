import { describe, expect, it } from "vitest";
import { parseEnabledSignInProviders } from "./sign-in-provider";

describe("parseEnabledSignInProviders", () => {
  it("accepts the compiled providers in canonical order", () => {
    expect(parseEnabledSignInProviders({ providers: ["github", "google"] })).toEqual({
      providers: ["github", "google"],
    });
  });

  it.each(["github", "google"] as const)("accepts the single enabled provider %s", (provider) => {
    expect(parseEnabledSignInProviders({ providers: [provider] })).toEqual({
      providers: [provider],
    });
  });

  it.each([
    [{ providers: [] }, "empty"],
    [{ providers: ["github", "github"] }, "duplicate"],
    [{ providers: ["google", "github"] }, "out of order"],
    [{ providers: ["github", "saml"] }, "unknown"],
    [{ providers: ["github"], label: "GitHub" }, "extra metadata"],
  ])("rejects a non-canonical provider response: %s (%s)", (value) => {
    expect(() => parseEnabledSignInProviders(value)).toThrow();
  });
});
