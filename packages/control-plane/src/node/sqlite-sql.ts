/**
 * SQL text handling shared by the Node host's SQLite adapters: what both
 * the per-session storage and the global store must recognize before
 * handing text to `node:sqlite`.
 */

/**
 * Whether SQLite would consume this input without producing a statement.
 *
 * SQLite reports success with a null statement pointer for whitespace, a BOM,
 * comments, empty statements, and input terminated by NUL. Node versions
 * before 26.8 wrap and track that pointer, then leave a dangling registry entry
 * when the wrapper is collected. Never pass that input to
 * DatabaseSync.prepare().
 */
export function isStatementlessSql(sql: string): boolean {
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    const code = sql.charCodeAt(index);
    if (code === 0x00) return true;
    if (
      char === ";" ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d ||
      code === 0x20 ||
      code === 0xfeff
    ) {
      index += 1;
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") {
      const newline = sql.indexOf("\n", index + 2);
      index = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    return false;
  }
  return true;
}
