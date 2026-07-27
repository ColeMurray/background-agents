import { describe, expect, it, vi } from "vitest";
import { GoogleSignInProfileResolver } from "./google-profile";

describe("GoogleSignInProfileResolver", () => {
  it("verifies Google claims before admission and profile mapping", async () => {
    const verifyIdToken = vi.fn(async () => ({
      iss: "https://accounts.google.com",
      sub: "google-subject",
      email: "Person@Example.com",
      email_verified: true,
      name: "Person Example",
      picture: "https://example.com/avatar.png",
    }));
    const requireAdmission = vi.fn(async () => ({ reason: "email_allowlist" as const }));
    const resolver = new GoogleSignInProfileResolver(
      {
        clientId: "google-client-id",
        admissionPolicy: { requireAdmission },
      },
      { verifyIdToken }
    );

    const result = await resolver.getUserInfo({ idToken: "signed-google-id-token" });

    expect(verifyIdToken).toHaveBeenCalledWith({
      token: "signed-google-id-token",
      audience: "google-client-id",
    });
    expect(requireAdmission).toHaveBeenCalledWith({
      identity: {
        provider: "google",
        issuer: "https://accounts.google.com",
        subject: "google-subject",
        displayName: "Person Example",
        avatarUrl: "https://example.com/avatar.png",
        verifiedEmails: ["person@example.com"],
        primaryEmail: "person@example.com",
      },
      credential: null,
    });
    expect(result.user).toEqual({
      id: "google-subject",
      name: "Person Example",
      email: "person@example.com",
      image: "https://example.com/avatar.png",
      emailVerified: true,
    });
  });

  it("rejects an unverifiable ID token before admission", async () => {
    const requireAdmission = vi.fn();
    const resolver = new GoogleSignInProfileResolver(
      {
        clientId: "google-client-id",
        admissionPolicy: { requireAdmission },
      },
      { verifyIdToken: vi.fn(async () => null) }
    );

    await expect(resolver.getUserInfo({ idToken: "invalid-id-token" })).rejects.toMatchObject({
      name: "OAuthProviderError",
      failure: "malformed_response",
    });
    expect(requireAdmission).not.toHaveBeenCalled();
  });

  it("rejects an unverified provider email before admission", async () => {
    const requireAdmission = vi.fn();
    const resolver = new GoogleSignInProfileResolver(
      {
        clientId: "google-client-id",
        admissionPolicy: { requireAdmission },
      },
      {
        verifyIdToken: vi.fn(async () => ({
          iss: "https://accounts.google.com",
          sub: "google-subject",
          email: "person@example.com",
          email_verified: false,
        })),
      }
    );

    await expect(resolver.getUserInfo({ idToken: "signed-id-token" })).rejects.toMatchObject({
      name: "OAuthProviderError",
      failure: "malformed_response",
    });
    expect(requireAdmission).not.toHaveBeenCalled();
  });
});
