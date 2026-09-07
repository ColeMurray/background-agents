import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { applyMigrations } from "../node/migrate";
import { seedSessionInboxWork } from "../../test/fixtures/session-inbox-work";
import { SessionInboxStore } from "./session-inbox-store";

describe("session inbox query shape on the Node adapter", () => {
  let sqlite: DatabaseSync;
  let db: NodeSqlDatabase;
  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON");
    applyMigrations(
      sqlite,
      fileURLToPath(new URL("../../../../terraform/d1/migrations/", import.meta.url))
    );
    db = createNodeSqlDatabase(sqlite);
  });
  afterEach(() => db.close());

  it.each(["dense", "sparse"] as const)(
    "keeps %s snapshot and list results aligned without materializing wide rows",
    async (shape) => {
      await seedSessionInboxWork(db, 4000, shape);
      const queries: string[] = [];
      const store = new SessionInboxStore({
        prepare(query) {
          queries.push(query);
          return db.prepare(query);
        },
        batch: db.batch.bind(db),
      });
      const options = {
        viewerUserId: "query-viewer",
        createdByUserIds: ["query-viewer"],
        limit: 20,
      };
      const snapshot = await store.snapshot(options);
      const snapshotQuery = queries[0];
      queries.length = 0;
      const firstPage = await store.list({ ...options, category: "finished", cursor: null });
      const listQuery = queries[0];
      expect(firstPage).toEqual(snapshot.finished);
      expect(firstPage.items).toHaveLength(20);
      expect(firstPage.items[0].rootSession.id).toBe("work-1");
      expect(firstPage.items[0].descendantSessions.map((session) => session.id)).toEqual([
        "work-2",
      ]);
      expect(firstPage.items.some((item) => item.rootSession.id === "work-22")).toBe(
        shape === "sparse"
      );
      expect(snapshot.in_progress.items).toEqual([]);
      expect(snapshot.needs_attention.items).toEqual([]);
      const secondPage = await store.list({
        ...options,
        category: "finished",
        cursor: firstPage.nextCursor,
      });
      expect(secondPage.items).toHaveLength(20);
      const firstIds = new Set(firstPage.items.map((item) => item.rootSession.id));
      expect(secondPage.items.every((item) => !firstIds.has(item.rootSession.id))).toBe(true);
      for (const [query, params] of [
        [snapshotQuery, ["query-viewer", "query-viewer", 21]],
        [listQuery, ["query-viewer", "query-viewer", "finished", 21]],
      ] as const) {
        const plan = sqlite
          .prepare("EXPLAIN QUERY PLAN " + query)
          .all(...params)
          .map((row) => row.detail)
          .join("\n");
        expect(plan).not.toContain("MATERIALIZE eligible_sessions");
        expect(plan).toContain("MATERIALIZE eligible_session_links");
        expect(plan).toMatch(/SEARCH child USING AUTOMATIC .*INDEX \(parent_session_id=\?\)/);
        // The narrow table belongs only to the recursive arm, not seed detection.
        expect(query).toContain("FROM eligible_sessions eligible");
        expect(query).toContain("FROM eligible_sessions parent");
        expect(query).toContain("JOIN eligible_session_links child");
      }
    }
  );
});
