/**
 * Personal access tokens: the credential a user issues to themselves so a
 * local tool — the MCP server, a script — can read the control plane as them.
 *
 * The plaintext token exists in exactly two places: the response to the call
 * that created it, and wherever the user pastes it. The control plane stores
 * only a SHA-256 hash, so a database read cannot recover a working credential.
 */

import { z } from "zod";

/**
 * Marks a string as one of ours on sight, so a leaked token is recognisable
 * in a log or a paste and can be revoked without guesswork.
 */
export const ACCESS_TOKEN_PREFIX = "oi_pat_";

/** Random bytes behind the prefix. 256 bits, hex-encoded. */
export const ACCESS_TOKEN_RANDOM_BYTES = 32;

/**
 * Leading characters retained in cleartext for display, counted from the end
 * of the prefix. Enough to tell two tokens apart in a list, far too few to
 * narrow a brute force.
 */
export const ACCESS_TOKEN_DISPLAY_CHARS = 6;

const ACCESS_TOKEN_HEX_LENGTH = ACCESS_TOKEN_RANDOM_BYTES * 2;

export const accessTokenPattern = new RegExp(
  `^${ACCESS_TOKEN_PREFIX}[0-9a-f]{${ACCESS_TOKEN_HEX_LENGTH}}$`
);

/** Whether a string is shaped like an access token, before any lookup. */
export function isAccessTokenFormat(value: string): boolean {
  return accessTokenPattern.test(value);
}

/** The non-secret half of a token, safe to list and to log. */
export const accessTokenSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  /** `oi_pat_` plus ACCESS_TOKEN_DISPLAY_CHARS characters, for disambiguation. */
  displayPrefix: z.string(),
  createdAt: z.number(),
  lastUsedAt: z.number().nullable(),
  expiresAt: z.number().nullable(),
});
export type AccessToken = z.infer<typeof accessTokenSchema>;

/**
 * A creation response. `token` is present here and nowhere else — no later
 * read returns it.
 */
export const createdAccessTokenSchema = accessTokenSchema.extend({
  token: z.string(),
});
export type CreatedAccessToken = z.infer<typeof createdAccessTokenSchema>;

export const ACCESS_TOKEN_NAME_MAX_LENGTH = 100;

/** Bounds on how long a token may remain valid, chosen at creation. */
export const ACCESS_TOKEN_MIN_TTL_DAYS = 1;
export const ACCESS_TOKEN_MAX_TTL_DAYS = 365;

export const createAccessTokenRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(ACCESS_TOKEN_NAME_MAX_LENGTH),
  /** Omitted means no expiry. */
  expiresInDays: z
    .number()
    .int()
    .min(ACCESS_TOKEN_MIN_TTL_DAYS)
    .max(ACCESS_TOKEN_MAX_TTL_DAYS)
    .optional(),
});
export type CreateAccessTokenRequest = z.infer<typeof createAccessTokenRequestSchema>;

export const listAccessTokensResponseSchema = z.strictObject({
  tokens: z.array(accessTokenSchema),
});
export type ListAccessTokensResponse = z.infer<typeof listAccessTokensResponseSchema>;
