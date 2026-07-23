/**
 * Single point where engine-specific database error text is interpreted.
 * Today this matches SQLite/D1's message; a future engine adapter extends the
 * match here (e.g. Postgres SQLSTATE 23505) instead of per-store string checks.
 */
export function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.toLowerCase().includes("unique constraint failed");
}
