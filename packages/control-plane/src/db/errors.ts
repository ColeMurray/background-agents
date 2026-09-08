/**
 * Single point where engine-specific database error text is interpreted.
 * D1 surfaces constraint failures as message text; `node:sqlite` also
 * carries the SQLite result code. A future engine adapter extends the match
 * here (e.g. Postgres SQLSTATE 23505) instead of per-store string checks.
 */

const SQLITE_CONSTRAINT_UNIQUE = 2067;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;

export function isUniqueConstraintError(err: unknown): boolean {
  const code = (err as { errcode?: unknown } | null)?.errcode;
  if (code === SQLITE_CONSTRAINT_UNIQUE || code === SQLITE_CONSTRAINT_PRIMARYKEY) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.toLowerCase().includes("unique constraint failed");
}
