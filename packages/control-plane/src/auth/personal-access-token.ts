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

/**
 * Resolves a presented token to its credential, or null when it is unknown or expired. Callers
 * report both failures identically: telling them apart would confirm that a guessed token had
 * once existed.
 */
export async function authenticatePersonalAccessToken(
  tokens: PersonalAccessTokenLookup,
  token: string,
  now: number
): Promise<PersonalAccessTokenCredential | null> {
  const credential = await tokens.findByToken(token);
  if (!credential || credential.expiresAt <= now) return null;
  return credential;
}
