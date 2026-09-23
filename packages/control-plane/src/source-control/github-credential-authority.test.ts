import { describe, expect, it, vi } from "vitest";
import {
  resolveGitHubCredentialAuthority,
  type GitHubCredentialAuthorityContext,
  type ProviderAccountClient,
} from "./github-credential-authority";
import type { AuthenticationContext } from "../auth/principal";

const BROWSER_AUTHENTICATION: AuthenticationContext = {
  mechanism: "browser_session",
  credentialId: "session-1",
  channel: {
    kind: "sig1",
    service: "web",
  },
};

const BROWSER_HEADERS = new Headers({
  Cookie: "openinspect.session_token=session-token",
});

function createContext(
  overrides: Partial<GitHubCredentialAuthorityContext>
): GitHubCredentialAuthorityContext {
  return {
    principal: {
      kind: "service",
      service: "linear-bot",
      actor: null,
    },
    ...overrides,
  };
}

function createUserContext(accounts: unknown[]) {
  const listUserAccounts = vi.fn(async () => accounts);
  const getAccessToken = vi.fn(async () => ({ accessToken: "current-access-token" }));
  const accountClient: ProviderAccountClient = {
    listUserAccounts,
    getAccessToken,
    refreshToken: vi.fn(async () => null),
    accountInfo: vi.fn(async () => null),
  };
  const runtime = {
    api: accountClient,
  };
  return {
    context: createContext({
      principal: { kind: "user", userId: "user-1" },
      authentication: BROWSER_AUTHENTICATION,
      getUserAuth: () => runtime,
    }),
    listUserAccounts,
    getAccessToken,
    accountClient,
  };
}

describe("resolveGitHubCredentialAuthority", () => {
  it("selects a linked GitHub account only when credential authority is requested", async () => {
    const { context, listUserAccounts, accountClient } = createUserContext([
      {
        providerId: "github",
        accountId: "583231",
        userId: "user-1",
      },
      {
        providerId: "google",
        accountId: "google-subject",
        userId: "user-1",
      },
    ]);

    const authority = await resolveGitHubCredentialAuthority(context, BROWSER_HEADERS);
    expect(authority).toEqual({
      kind: "browser_session",
      githubAccount: {
        subject: "583231",
        resolveProfile: expect.any(Function),
      },
    });
    expect(listUserAccounts).toHaveBeenCalledWith({ headers: BROWSER_HEADERS });

    if (authority.kind !== "browser_session" || !authority.githubAccount) {
      throw new Error("Expected GitHub browser authority");
    }
    await authority.githubAccount.resolveProfile();
    expect(accountClient.getAccessToken).toHaveBeenCalledWith({
      body: { providerId: "github", accountId: "583231", userId: "user-1" },
    });
    expect(accountClient.accountInfo).toHaveBeenCalledWith({
      query: { providerId: "github", accountId: "583231", userId: "user-1" },
    });
  });

  it("does not request a profile for a linked identity without an OAuth grant", async () => {
    const { context, getAccessToken, accountClient } = createUserContext([
      { providerId: "github", accountId: "583231", userId: "user-1" },
    ]);
    getAccessToken.mockResolvedValueOnce({ accessToken: "" });

    const authority = await resolveGitHubCredentialAuthority(context, BROWSER_HEADERS);
    if (authority.kind !== "browser_session" || !authority.githubAccount) {
      throw new Error("Expected GitHub browser authority");
    }
    await expect(authority.githubAccount.resolveProfile()).resolves.toBeNull();
    expect(accountClient.accountInfo).not.toHaveBeenCalled();
  });

  it("allows browser users without a linked GitHub account", async () => {
    const { context } = createUserContext([
      {
        providerId: "google",
        accountId: "google-subject",
        userId: "user-1",
      },
    ]);

    await expect(resolveGitHubCredentialAuthority(context, BROWSER_HEADERS)).resolves.toEqual({
      kind: "browser_session",
      githubAccount: null,
    });
  });

  it("rejects cross-user GitHub account authority", async () => {
    const { context } = createUserContext([
      {
        providerId: "github",
        accountId: "583231",
        userId: "different-user",
      },
    ]);

    await expect(resolveGitHubCredentialAuthority(context, BROWSER_HEADERS)).rejects.toThrow(
      "GitHub account authority is corrupt"
    );
  });

  it("rejects multiple linked GitHub accounts", async () => {
    const { context } = createUserContext([
      { providerId: "github", accountId: "583231", userId: "user-1" },
      { providerId: "github", accountId: "987654", userId: "user-1" },
    ]);
    await expect(resolveGitHubCredentialAuthority(context, BROWSER_HEADERS)).rejects.toThrow(
      "User resolves to multiple GitHub provider accounts"
    );
  });

  it("rejects a user principal without browser-session provenance", async () => {
    await expect(
      resolveGitHubCredentialAuthority(
        createContext({
          principal: { kind: "user", userId: "user-1" },
        }),
        BROWSER_HEADERS
      )
    ).rejects.toThrow("User principal is missing browser-session provenance");
  });

  it("does not construct Better Auth for service principals", async () => {
    const getUserAuth = vi.fn(() => {
      throw new Error("At least one sign-in provider must be configured");
    });

    await expect(
      resolveGitHubCredentialAuthority(createContext({ getUserAuth }), BROWSER_HEADERS)
    ).resolves.toEqual({ kind: "service_principal" });
    expect(getUserAuth).not.toHaveBeenCalled();
  });

  it("rejects sandbox principals", async () => {
    await expect(
      resolveGitHubCredentialAuthority(
        createContext({ principal: { kind: "sandbox", sessionId: "session-1" } }),
        BROWSER_HEADERS
      )
    ).rejects.toThrow("Principal cannot authorize GitHub user credentials");
  });
});
