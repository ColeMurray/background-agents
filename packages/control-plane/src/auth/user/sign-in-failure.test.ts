import { describe, expect, it, vi } from "vitest";
import { AdmissionDeniedError, AdmissionUnavailableError } from "./admission-policy";
import type { ProviderProfile } from "./provider-profile";
import { OAuthProviderError } from "./providers/types";
import { redirectSignInFailures } from "./sign-in-failure";

const profile: ProviderProfile = {
  user: { id: "583231", email: "octocat@example.com", emailVerified: true },
  data: {},
};

async function redirectFor(error: unknown): Promise<{ statusCode: number; location: string }> {
  const resolver = redirectSignInFailures("github", vi.fn().mockRejectedValue(error));
  const thrown = await resolver({ accessToken: "ghu-access" }).then(
    () => {
      throw new Error("expected a redirect");
    },
    (redirect: unknown) => redirect
  );
  expect(thrown).toMatchObject({ name: "APIError", status: "FOUND" });
  const { statusCode, headers } = thrown as { statusCode: number; headers: HeadersInit };
  return { statusCode, location: new Headers(headers).get("Location") ?? "" };
}

describe("redirectSignInFailures", () => {
  it("passes a resolved profile through unchanged", async () => {
    const resolver = redirectSignInFailures("github", vi.fn().mockResolvedValue(profile));

    await expect(resolver({ accessToken: "ghu-access" })).resolves.toBe(profile);
  });

  it("redirects an admission denial to the access-denied page", async () => {
    await expect(redirectFor(new AdmissionDeniedError())).resolves.toEqual({
      statusCode: 302,
      location: "/access-denied?error=access_denied&provider=github",
    });
  });

  it("redirects an unavailable admission check with its own reason", async () => {
    await expect(redirectFor(new AdmissionUnavailableError())).resolves.toEqual({
      statusCode: 302,
      location: "/access-denied?error=admission_unavailable&provider=github",
    });
  });

  it("redirects a provider failure with its failure kind", async () => {
    await expect(
      redirectFor(new OAuthProviderError("provider_rejected", "GitHub email lookup was rejected"))
    ).resolves.toEqual({
      statusCode: 302,
      location: "/access-denied?error=provider_rejected&provider=github",
    });
  });

  it("rethrows an unexpected error unchanged", async () => {
    const bug = new TypeError("unexpected");
    const resolver = redirectSignInFailures("google", vi.fn().mockRejectedValue(bug));

    await expect(resolver({ idToken: "id-token" })).rejects.toBe(bug);
  });
});
