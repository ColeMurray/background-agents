import { describe, expect, it, vi } from "vitest";
import { GitHubSignInProfileResolver } from "./github-profile";

describe("GitHubSignInProfileResolver", () => {
  it("resolves verified GitHub evidence before admission and profile mapping", async () => {
    const resolveIdentity = vi.fn(async () => ({
      provider: "github" as const,
      issuer: "https://github.com",
      subject: "583231",
      login: "octocat",
      displayName: "The Octocat",
      avatarUrl: "https://github.com/images/error/octocat_happy.gif",
      verifiedEmails: ["secondary@example.com", "primary@example.com"],
      primaryEmail: "primary@example.com",
    }));
    const requireAdmission = vi.fn(async () => ({
      reason: "github_user_allowlist" as const,
    }));
    const resolver = new GitHubSignInProfileResolver({
      identityResolver: { resolveIdentity },
      admissionPolicy: { requireAdmission },
    });
    const accessTokenExpiresAt = new Date("2026-07-27T00:00:00.000Z");
    const refreshTokenExpiresAt = new Date("2026-08-27T00:00:00.000Z");

    const result = await resolver.getUserInfo({
      accessToken: "github-access-token",
      accessTokenExpiresAt,
      refreshToken: "github-refresh-token",
      refreshTokenExpiresAt,
    });

    expect(resolveIdentity).toHaveBeenCalledWith("github-access-token");
    expect(requireAdmission).toHaveBeenCalledWith({
      identity: {
        provider: "github",
        issuer: "https://github.com",
        subject: "583231",
        login: "octocat",
        displayName: "The Octocat",
        avatarUrl: "https://github.com/images/error/octocat_happy.gif",
        verifiedEmails: ["secondary@example.com", "primary@example.com"],
        primaryEmail: "primary@example.com",
      },
      credential: {
        kind: "refreshable",
        accessToken: "github-access-token",
        accessExpiresAt: accessTokenExpiresAt.getTime(),
        refreshToken: "github-refresh-token",
        refreshExpiresAt: refreshTokenExpiresAt.getTime(),
      },
    });
    expect(result.user).toEqual({
      id: "583231",
      name: "The Octocat",
      email: "primary@example.com",
      image: "https://github.com/images/error/octocat_happy.gif",
      emailVerified: true,
    });
  });

  it("rejects missing access-token evidence before lookup or admission", async () => {
    const resolveIdentity = vi.fn();
    const requireAdmission = vi.fn();
    const resolver = new GitHubSignInProfileResolver({
      identityResolver: { resolveIdentity },
      admissionPolicy: { requireAdmission },
    });

    await expect(resolver.getUserInfo({})).rejects.toMatchObject({
      name: "OAuthProviderError",
      failure: "malformed_response",
    });
    expect(resolveIdentity).not.toHaveBeenCalled();
    expect(requireAdmission).not.toHaveBeenCalled();
  });

  it("rejects an identity without a verified email before admission", async () => {
    const requireAdmission = vi.fn();
    const resolver = new GitHubSignInProfileResolver({
      identityResolver: {
        resolveIdentity: vi.fn(async () => ({
          provider: "github" as const,
          issuer: "https://github.com",
          subject: "583231",
          login: "octocat",
          verifiedEmails: [],
          primaryEmail: null,
        })),
      },
      admissionPolicy: { requireAdmission },
    });

    await expect(
      resolver.getUserInfo({ accessToken: "github-access-token" })
    ).rejects.toMatchObject({
      name: "OAuthProviderError",
      failure: "malformed_response",
    });
    expect(requireAdmission).not.toHaveBeenCalled();
  });
});
