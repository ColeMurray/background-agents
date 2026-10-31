/**
 * Authenticating a personal access token presented as `Authorization: Bearer <token>`.
 *
 * A token resolves to its owner and carries the grant chosen when it was issued. Authentication
 * only establishes who presented it; route admission decides whether the route accepts tokens at
 * all, and narrows the owner's permissions to the grant.
 */

import {
  isPersonalAccessTokenFormat,
  PERSONAL_ACCESS_TOKEN_DISPLAY_CHARS,
  PERSONAL_ACCESS_TOKEN_PREFIX,
  personalAccessTokenEffectiveExpiry,
  personalAccessTokenPolicyAllows,
  type PersonalAccessTokenPolicy,
} from "@open-inspect/shared/types/personal-access-tokens";
import type { PersonalAccessTokenCredential } from "../db/personal-access-tokens";

const BEARER_SCHEME = /^Bearer +(\S+)\s*$/i;

/**
 * The token in an Authorization header, or null for a header that is absent, not Bearer, or not
 * shaped like one of ours. Shape is checked before any lookup, so another bearer credential (a
 * sandbox token on a sandbox-fallback route) falls through to its own scheme without a query.
 */
export function readPersonalAccessToken(headers: Headers): string | null {
  const match = BEARER_SCHEME.exec(headers.get("Authorization") ?? "");
  if (!match) return null;
  return isPersonalAccessTokenFormat(match[1]) ? match[1] : null;
}

/** The non-secret leading characters of a token, as its list entry displays them. */
export function personalAccessTokenDisplayPrefix(token: string): string {
  return token.slice(0, PERSONAL_ACCESS_TOKEN_PREFIX.length + PERSONAL_ACCESS_TOKEN_DISPLAY_CHARS);
}

/** Looks up a presented token; satisfied by `PersonalAccessTokenStore`. */
export interface PersonalAccessTokenLookup {
  findByToken(token: string): Promise<PersonalAccessTokenCredential | null>;
}

/** Reads the workspace's token policy; satisfied by `PersonalAccessTokenPolicyStore`. */
export interface PersonalAccessTokenPolicySource {
  get(): Promise<PersonalAccessTokenPolicy>;
}

export type PersonalAccessTokenAuthentication =
  | { kind: "authenticated"; credential: PersonalAccessTokenCredential }
  /** Unknown, expired, or past the policy's lifetime cap; reported identically to the caller. */
  | { kind: "rejected" }
  /**
   * The workspace policy has turned tokens off. Reported only for a live token, which tells its
   * holder nothing they could not already learn by using it.
   */
  | { kind: "disabled" };

/**
 * Resolves a presented token under the workspace policy. The policy applies to existing tokens:
 * a lifetime cap lower than a token's own expiry ends it early, and a permission ceiling narrows
 * its grant. Unknown and expired tokens are reported identically: telling them apart would
 * confirm that a guessed token had once existed.
 *
 * The policy is read only once the token is found, so a forged token, which anyone can present,
 * costs a single lookup.
 */
export async function authenticatePersonalAccessToken(
  tokens: PersonalAccessTokenLookup,
  policies: PersonalAccessTokenPolicySource,
  token: string,
  now: number
): Promise<PersonalAccessTokenAuthentication> {
  const credential = await tokens.findByToken(token);
  if (!credential) return { kind: "rejected" };
  const policy = await policies.get();
  if (personalAccessTokenEffectiveExpiry(credential, policy) <= now) return { kind: "rejected" };
  if (!policy.enabled) return { kind: "disabled" };
  return {
    kind: "authenticated",
    credential: {
      ...credential,
      grant: credential.grant.filter((permission) =>
        personalAccessTokenPolicyAllows(policy, permission)
      ),
    },
  };
}
