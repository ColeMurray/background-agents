/**
 * The cache file is disposable: every entry can be rebuilt by being used, so
 * a file that cannot be opened is replaced rather than allowed to fail a boot.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import { CACHE_STORE_FILE, openNodeCacheDatabase } from "./cache-database";

let dataDir: string;

const logger = (): Logger =>
  ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as unknown as Logger;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cache-database-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("openNodeCacheDatabase", () => {
  it("creates the table, and reopening keeps what was written", async () => {
    const first = openNodeCacheDatabase(dataDir);
    await first
      .prepare("INSERT INTO cache_entries (key, value) VALUES (?, ?)")
      .bind("k", "v")
      .run();
    first.close();

    const second = openNodeCacheDatabase(dataDir);
    try {
      expect(
        await second.prepare("SELECT value FROM cache_entries WHERE key = ?").bind("k").first()
      ).toEqual({ value: "v" });
    } finally {
      second.close();
    }
  });

  it("discards a corrupt file and boots on a fresh one", async () => {
    const path = join(dataDir, CACHE_STORE_FILE);
    writeFileSync(path, "this is not a SQLite database");
    const log = logger();

    const db = openNodeCacheDatabase(dataDir, log);
    try {
      // The replacement is a working, empty cache rather than a failed boot.
      const row = await db
        .prepare("SELECT count(*) AS n FROM cache_entries")
        .first<{ n: number }>();
      expect(row!.n).toBe(0);
    } finally {
      db.close();
    }

    expect(readFileSync(path).subarray(0, 6).toString()).toBe("SQLite");
    expect(log.warn).toHaveBeenCalledWith(
      "Discarding an unusable cache database",
      expect.objectContaining({ event: "node_host.cache_database_discarded" })
    );
  });
});
