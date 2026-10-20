import { describe, expect, it, vi } from "vitest";
import { AdmissionDeniedError, AdmissionUnavailableError } from "./admission-policy";
import { OAuthProviderError } from "./providers/types";
import { signInFailureLocation } from "./sign-in-failure";

describe("signInFailureLocation", () => {
  it.each([
    [new AdmissionDeniedError(), "access_denied"],
    [new AdmissionUnavailableError(), "admission_unavailable"],
    [new OAuthProviderError("provider_rejected", "sensitive provider detail"), "provider_rejected"],
    [new OAuthProviderError("provider_unavailable", "outage"), "provider_unavailable"],
    [new OAuthProviderError("malformed_response", "invalid identity"), "malformed_response"],
  ])("redirects %s using a sanitized reason", (error, reason) => {
    expect(signInFailureLocation("github", error)).toBe(`/login?error=${reason}&provider=github`);
  });

  it("retains distinct server diagnostics while sharing a sanitized public reason", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const diagnostics = [
      "GitHub returned an invalid user",
      "GitHub returned invalid emails",
      "GitHub did not return a verified email",
    ];
    try {
      const locations = diagnostics.map((message) =>
        signInFailureLocation(
          "github",
          new OAuthProviderError("malformed_response", message, {
            cause: new Error("sensitive-provider-token"),
          })
        )
      );

      expect(locations).toEqual(
        diagnostics.map(() => "/login?error=malformed_response&provider=github")
      );
      const logs = warn.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(logs).toEqual(
        diagnostics.map((diagnostic) =>
          expect.objectContaining({
            event: "auth.sign_in_rejected",
            provider: "github",
            reason: "malformed_response",
            diagnostic,
          })
        )
      );
      expect(JSON.stringify(logs)).not.toContain("sensitive-provider-token");
    } finally {
      warn.mockRestore();
    }
  });

  it("leaves unexpected failures to the caller", () => {
    expect(signInFailureLocation("google", new TypeError("unexpected"))).toBeNull();
  });
});
