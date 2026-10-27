import { describe, expect, it, vi } from "vitest";
import { AdmissionDeniedError, AdmissionUnavailableError } from "./admission-policy";
import { GitHubEmailPermissionError } from "./providers/github-identity";
import { OAuthProviderError } from "./providers/types";
import { signInFailureReason, withSignInFailureRedirect } from "./sign-in-failure";

class TestRedirect extends Error {}

function failingResolver(error: unknown) {
  return withSignInFailureRedirect(
    "github",
    async (_tokens: unknown) => {
      throw error;
    },
    (reason) => new TestRedirect(reason)
  );
}

describe("signInFailureReason", () => {
  it.each([
    [new AdmissionDeniedError(), "admission_denied"],
    [new AdmissionUnavailableError(), "admission_unavailable"],
    [new GitHubEmailPermissionError(403), "github_email_permission_missing"],
    [new OAuthProviderError("provider_rejected", "sensitive provider detail"), "provider_rejected"],
    [new OAuthProviderError("provider_unavailable", "outage"), "provider_unavailable"],
    [new OAuthProviderError("malformed_response", "invalid identity"), "malformed_response"],
  ])("classifies %s as %s", (error, reason) => {
    expect(signInFailureReason(error)).toBe(reason);
  });

  it("leaves unexpected failures unclassified", () => {
    expect(signInFailureReason(new TypeError("unexpected"))).toBeNull();
  });
});

describe("withSignInFailureRedirect", () => {
  it("returns the profile when the resolver succeeds", async () => {
    const profile = { user: { id: "583231" } };
    const resolver = withSignInFailureRedirect(
      "github",
      async (_tokens: unknown) => profile,
      () => new TestRedirect()
    );

    await expect(resolver({})).resolves.toBe(profile);
  });

  it("rethrows unexpected failures unchanged", async () => {
    const error = new TypeError("unexpected");

    await expect(failingResolver(error)({})).rejects.toBe(error);
  });

  it("redirects known failures and logs distinct server diagnostics", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const diagnostics = [
      "GitHub returned an invalid user",
      "GitHub returned invalid emails",
      "GitHub did not return a verified email",
    ];
    try {
      for (const message of diagnostics) {
        const error = new OAuthProviderError("malformed_response", message, {
          cause: new Error("sensitive-provider-token"),
        });
        await expect(failingResolver(error)({})).rejects.toEqual(
          new TestRedirect("malformed_response")
        );
      }

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
});
