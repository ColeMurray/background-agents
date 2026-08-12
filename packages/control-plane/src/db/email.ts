/**
 * Canonical email normalization for every database write, lookup, and
 * comparison, kept equal to the SQL-side `lower(trim(...))` used by the
 * sign-in claim queries and migration 0057. `idx_users_email` is COLLATE
 * NOCASE but not whitespace-normalizing, so an untrimmed write could create a
 * whitespace-variant duplicate of an existing email.
 *
 * A blank (or whitespace-only) email normalizes to `null`: `idx_users_email`
 * is unique, so persisting `""` would make every blank-emailed identity
 * collide on one slot instead of being treated as absent.
 *
 * `user-merge.ts` carries a byte-identical mirror: the operator CLI loads it
 * under Node's type-stripping loader, which cannot resolve extensionless
 * runtime imports, so that module must stay free of value imports. Change
 * both together.
 */
export function normalizeEmail(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase();
  return normalized ? normalized : null;
}
