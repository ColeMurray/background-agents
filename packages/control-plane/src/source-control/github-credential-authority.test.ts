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
  const accountClient: ProviderAccountClient = {
    listUserAccounts,
    getAccessToken: vi.fn(async () => null),
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

    await expect(resolveGitHubCredentialAuthority(context, BROWSER_HEADERS)).resolves.toEqual({
      kind: "browser_session",
      accountClient,
      githubAccount: { subject: "583231" },
    });
    expect(listUserAccounts).toHaveBeenCalledWith({ headers: BROWSER_HEADERS });
  });

  it("allows browser users without a linked GitHub account", async () => {
    const { context, accountClient } = createUserContext([
      {
        providerId: "google",
        accountId: "google-subject",
        userId: "user-1",
      },
    ]);

    await expect(resolveGitHubCredentialAuthority(context, BROWSER_HEADERS)).resolves.toEqual({
      kind: "browser_session",
      accountClient,
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

  it("uses the legacy credential authority only for non-browser principals", async () => {
    await expect(
      resolveGitHubCredentialAuthority(createContext({}), BROWSER_HEADERS)
    ).resolves.toEqual({ kind: "legacy" });
  });
});
