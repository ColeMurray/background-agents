import { describe, expect, it } from "vitest";
import {
  resolveGitHubCredentialAuthority,
  type GitHubCredentialAuthorityContext,
} from "./github-credential-authority";

function createContext(
  overrides: Partial<GitHubCredentialAuthorityContext>
): GitHubCredentialAuthorityContext {
  return {
    principal: {
      kind: "service",
      service: "modal",
      actor: null,
    },
    ...overrides,
  };
}

describe("resolveGitHubCredentialAuthority", () => {
  it("binds browser users to their Better Auth account authority", () => {
    const runtime = {} as never;
    const authentication = {
      mechanism: "browser_session" as const,
      credentialId: "session-1",
      githubAccount: {
        id: "account-1",
        subject: "583231",
      },
      channel: {
        kind: "sig1" as const,
        service: "web" as const,
      },
    };

    expect(
      resolveGitHubCredentialAuthority(
        createContext({
          principal: { kind: "user", userId: "user-1" },
          authentication,
          getBrowserAuth: () => runtime,
        })
      )
    ).toEqual({
      kind: "browser_session",
      runtime,
      githubAccount: authentication.githubAccount,
    });
  });

  it("rejects a user principal without browser-session provenance", () => {
    expect(() =>
      resolveGitHubCredentialAuthority(
        createContext({
          principal: { kind: "user", userId: "user-1" },
        })
      )
    ).toThrow("User principal is missing browser-session provenance");
  });

  it("uses the legacy credential authority only for non-browser principals", () => {
    expect(resolveGitHubCredentialAuthority(createContext({}))).toEqual({ kind: "legacy" });
  });
});
