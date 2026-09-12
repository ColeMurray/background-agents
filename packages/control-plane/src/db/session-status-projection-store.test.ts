import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { SessionStatusProjectionStore } from "./session-status-projection-store";

let db: NodeSqlDatabase;
let store: SessionStatusProjectionStore;
beforeEach(async () => {
  db = createNodeSqlDatabase(new DatabaseSync(":memory:"));
  await db
    .prepare(
      "CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT, updated_at INTEGER, status_revision INTEGER NOT NULL DEFAULT 0)"
    )
    .run();
  await db
    .prepare("INSERT INTO sessions (id, status, updated_at) VALUES ('one', 'completed', 5000)")
    .run();
  store = new SessionStatusProjectionStore(db);
});
afterEach(() => db.close());
const read = () =>
  db.prepare("SELECT status, updated_at, status_revision FROM sessions WHERE id = 'one'").first();

it("projects a lifecycle revision despite newer activity without reducing recency", async () => {
  expect(await store.project("one", "archived", 2, 2000)).toBe(true);
  expect(await read()).toEqual({ status: "archived", updated_at: 5000, status_revision: 2 });
  expect(await store.project("one", "completed", 1, 9000)).toBe(false);
  expect(await store.updateUnclaimed("one", "failed", 9000)).toBe(false);
});
it("rejects delayed archive writes after an equal-timestamp unarchive", async () => {
  expect(await store.project("one", "completed", 3, 5000)).toBe(true);
  expect(await store.project("one", "archived", 2, 5000)).toBe(false);
  expect(await read()).toEqual({ status: "completed", updated_at: 5000, status_revision: 3 });
});
it("fences older delivery even when repairing an already archived row", async () => {
  await db.prepare("UPDATE sessions SET status = 'archived'").run();
  expect(await store.project("one", "archived", 3, 6000)).toBe(true);
  expect(await store.project("one", "completed", 2, 7000)).toBe(false);
  expect(await read()).toEqual({ status: "archived", updated_at: 6000, status_revision: 3 });
});
it("accepts identical retries but rejects conflicting equal revisions and missing rows", async () => {
  expect(await store.project("one", "archived", 2, 5000)).toBe(true);
  expect(await store.project("one", "archived", 2, 5000)).toBe(true);
  expect(await store.project("one", "active", 2, 5000)).toBe(false);
  expect(await store.project("missing", "active", 2, 5000)).toBe(false);
});
it("does not retire a draft claimed by the runtime", async () => {
  expect(await store.project("one", "created", 1, 5000)).toBe(true);
  expect(await store.archiveOrphanedDraft("one")).toBe(false);
});
