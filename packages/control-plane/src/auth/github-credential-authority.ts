import type { BrowserAuthRuntime } from "./browser-auth-runtime";
import type { AuthenticationContext, Principal } from "./principal";

export type GitHubCredentialAuthority =
  | {
      readonly kind: "browser_session";
      readonly runtime: BrowserAuthRuntime;
      readonly githubAccount: AuthenticationContext["githubAccount"];
    }
  | {
      readonly kind: "legacy";
    };

export interface GitHubCredentialAuthorityContext {
  readonly principal?: Principal;
  readonly authentication?: AuthenticationContext;
  readonly getBrowserAuth?: () => BrowserAuthRuntime;
}

/**
 * Select the credential store associated with the verified principal.
 *
 * A browser user must never silently fall back to the legacy token store when
 * its authentication provenance is missing. Service actors are the only
 * transitional callers that retain the legacy authority.
 */
export function resolveGitHubCredentialAuthority(
  context: GitHubCredentialAuthorityContext
): GitHubCredentialAuthority {
  if (!context.principal) {
    throw new Error("Verified principal is unavailable");
  }

  if (context.principal.kind === "user") {
    if (!context.authentication) {
      throw new Error("User principal is missing browser-session provenance");
    }
    if (!context.getBrowserAuth) {
      throw new Error("Browser authentication runtime is unavailable");
    }
    return {
      kind: "browser_session",
      runtime: context.getBrowserAuth(),
      githubAccount: context.authentication.githubAccount,
    };
  }

  if (context.authentication) {
    throw new Error("Non-user principal cannot carry browser-session provenance");
  }
  return { kind: "legacy" };
}
