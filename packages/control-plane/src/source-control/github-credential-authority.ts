import { z } from "zod";
import type { AuthenticationContext, Principal } from "../auth/principal";

const providerAccountSchema = z.object({
  providerId: z.string().min(1),
  accountId: z.string().min(1),
  userId: z.string().min(1),
});

export interface GitHubAccountSelection {
  readonly subject: string;
}

interface ProviderAccountSelection {
  readonly providerId: "github";
  readonly accountId: string;
  readonly userId: string;
}

export interface ProviderAccountClient {
  listUserAccounts(input: { readonly headers: Headers }): Promise<unknown>;
  getAccessToken(input: { readonly body: ProviderAccountSelection }): Promise<unknown>;
  accountInfo(input: { readonly query: ProviderAccountSelection }): Promise<unknown>;
}

export type GitHubCredentialAuthority =
  | {
      readonly kind: "browser_session";
      readonly accountClient: ProviderAccountClient;
      readonly githubAccount: GitHubAccountSelection | null;
    }
  | {
      readonly kind: "legacy";
    };

export interface GitHubCredentialAuthorityContext {
  readonly principal?: Principal;
  readonly authentication?: AuthenticationContext;
  readonly getUserAuth?: () => { readonly api: ProviderAccountClient };
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
    if (!context.getUserAuth) {
      throw new Error("User authentication runtime is unavailable");
    }
    const accountClient = context.getUserAuth().api;
    const parsedAccounts = z
      .array(providerAccountSchema)
      .safeParse(await accountClient.listUserAccounts({ headers }));
    if (
      !parsedAccounts.success ||
      parsedAccounts.data.some((account) => account.userId !== userId)
    ) {
      throw new Error("GitHub account authority is corrupt");
    }
    const githubAccounts = parsedAccounts.data.filter((account) => account.providerId === "github");
    if (githubAccounts.length > 1) {
      throw new Error("User resolves to multiple GitHub provider accounts");
    }
    return {
      kind: "browser_session",
      accountClient,
      githubAccount: githubAccounts[0] ? { subject: githubAccounts[0].accountId } : null,
    };
  }

  if (context.authentication) {
    throw new Error("Non-user principal cannot carry browser-session provenance");
  }
  return { kind: "legacy" };
}
