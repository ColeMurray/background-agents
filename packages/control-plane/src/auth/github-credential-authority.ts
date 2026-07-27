import { z } from "zod";
import type { BrowserAuthRuntime } from "./browser-auth-runtime";
import type { AuthenticationContext, Principal } from "./principal";

const providerAccountSchema = z.object({
  providerId: z.string().min(1),
  accountId: z.string().min(1),
  userId: z.string().min(1),
});

export interface GitHubAccountSelection {
  readonly subject: string;
}

export type GitHubCredentialAuthority =
  | {
      readonly kind: "browser_session";
      readonly runtime: BrowserAuthRuntime;
      readonly githubAccount: GitHubAccountSelection | null;
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
 * its authentication provenance is missing. Linked GitHub accounts are
 * enumerated here, only when an SCM workflow requests them; they are not part
 * of browser-session authentication. Service actors are the only transitional
 * callers that retain the legacy authority.
 */
export async function resolveGitHubCredentialAuthority(
  context: GitHubCredentialAuthorityContext,
  headers: Headers
): Promise<GitHubCredentialAuthority> {
  if (!context.principal) {
    throw new Error("Verified principal is unavailable");
  }

  if (context.principal.kind === "user") {
    const userId = context.principal.userId;
    if (!context.authentication) {
      throw new Error("User principal is missing browser-session provenance");
    }
    if (!context.getBrowserAuth) {
      throw new Error("Browser authentication runtime is unavailable");
    }
    const runtime = context.getBrowserAuth();
    const parsedAccounts = z
      .array(providerAccountSchema)
      .safeParse(await runtime.api.listUserAccounts({ headers }));
    if (
      !parsedAccounts.success ||
      parsedAccounts.data.some((account) => account.userId !== userId)
    ) {
      throw new Error("Browser GitHub account authority is corrupt");
    }
    const githubAccounts = parsedAccounts.data.filter((account) => account.providerId === "github");
    if (githubAccounts.length > 1) {
      throw new Error("Browser user resolves to multiple GitHub provider accounts");
    }
    return {
      kind: "browser_session",
      runtime,
      githubAccount: githubAccounts[0] ? { subject: githubAccounts[0].accountId } : null,
    };
  }

  if (context.authentication) {
    throw new Error("Non-user principal cannot carry browser-session provenance");
  }
  return { kind: "legacy" };
}
