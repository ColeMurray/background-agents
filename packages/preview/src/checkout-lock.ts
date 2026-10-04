import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isProcessAlive } from "./process";

const LOCK_TRANSACTION_TIMEOUT_MS = 1000;

// Keep this database in place: unlinking it would let contenders lock different inodes.
// SQLite releases its OS lock even after SIGKILL. All file changes below are synchronous
// so another call in this process cannot block on a transaction suspended across an await.
function withLockTransaction(path: string, change: () => void): void {
  const database = new DatabaseSync(`${path}.sqlite`);
  try {
    database.exec(`PRAGMA busy_timeout = ${LOCK_TRANSACTION_TIMEOUT_MS}`);
    database.exec("BEGIN IMMEDIATE");
    change();
    database.exec("COMMIT");
  } finally {
    database.close();
  }
}

/** Takes over dead owners atomically; the returned release only removes this acquisition. */
export function acquireCheckoutLock(path: string): () => void {
  const content = JSON.stringify({ pid: process.pid, token: randomUUID() });
  withLockTransaction(path, () => {
    try {
      writeFileSync(path, content, { flag: "wx", mode: 0o600 });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let owner: unknown;
    try {
      owner = (JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown }).pid;
    } catch {
      // Unreadable or incomplete locks are conservatively treated as owned.
    }
    if (!Number.isInteger(owner) || (owner as number) <= 0 || isProcessAlive(owner as number))
      throw new Error(
        `preflight: checkout already owned; inspect ${path}. Stop its preview before starting another.`
      );
    unlinkSync(path);
    writeFileSync(path, content, { flag: "wx", mode: 0o600 });
  });
  return () =>
    withLockTransaction(path, () => {
      let current: string;
      try {
        current = readFileSync(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (current === content) unlinkSync(path);
    });
}
