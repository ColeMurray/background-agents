/**
 * Bound-parameter helpers for SQL `LIKE` predicates over user-supplied text.
 *
 * Every pattern built here must be used with `ESCAPE '\'` (see
 * `LIKE_ESCAPE_CLAUSE`) so that `%`, `_`, and `\` in the input match
 * themselves instead of acting as wildcards.
 */

const LIKE_SPECIAL_CHARACTERS = /[\\%_]/g;

/** SQL fragment to append after a `LIKE ?` whose pattern came from this module. */
export const LIKE_ESCAPE_CLAUSE = "ESCAPE '\\'";

export function escapeLikePattern(value: string): string {
  return value.replace(LIKE_SPECIAL_CHARACTERS, (character) => `\\${character}`);
}

/** Pattern matching any value that contains `value`. */
export function likeContains(value: string): string {
  return `%${escapeLikePattern(value)}%`;
}

/** Pattern matching any value that starts with `value` (including `value` itself). */
export function likePrefix(value: string): string {
  return `${escapeLikePattern(value)}%`;
}
