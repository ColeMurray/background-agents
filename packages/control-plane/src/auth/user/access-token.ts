/**
 * Authenticating a personal access token.
 *
 * A token is presented as `Authorization: Bearer <token>` and resolves to the
 * user who issued it. Unlike a browser session it carries no CSRF-relevant
 * ambient authority, and unlike a service signature it names a person — which
 * is what lets the routes it reaches scope their answers.
 */

import { isAccessTokenFormat } from "@open-inspect/shared/types/access-tokens";
import { PersonalAccessTokenStore } from "../../db/personal-access-tokens";
import type { SqlDatabase } from "../../db/sql-database";

const BEARER_SCHEME = /^Bearer (.+)$/;

/**
 * Extracts a token from an Authorization header.
 *
 * Returns null for a header that is absent, not Bearer, or not shaped like one
 * of our tokens. Shape is checked before any database work so that unrelated
 * bearer credentials fall through to the next scheme rather than costing a
 * query.
 */
export function readAccessTokenHeader(headers: Headers): string | null {
  const header = headers.get("Authorization");
  if (!header) return null;
  const match = BEARER_SCHEME.exec(header);
  if (!match) return null;
  const token = match[1].trim();
  return isAccessTokenFormat(token) ? token : null;
}

export interface AuthenticatedAccessToken {
  readonly userId: string;
  readonly tokenId: string;
}

/**
 * Resolves a presented token to its owner, or null if it is unknown or
 * expired. Both failures are reported identically to the caller: telling them
 * apart would confirm that a guessed token had once existed.
 */
export async function authenticateAccessToken(
  db: SqlDatabase,
  token: string,
  now: number = Date.now()
): Promise<AuthenticatedAccessToken | null> {
  const store = new PersonalAccessTokenStore(db);
  const identity = await store.findByToken(token);
  if (!identity) return null;
  if (identity.expiresAt !== null && identity.expiresAt <= now) return null;
  return { userId: identity.userId, tokenId: identity.id };
}
