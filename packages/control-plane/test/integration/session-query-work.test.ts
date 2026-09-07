import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createRequestMetrics,
  instrumentSqlDatabase,
} from "../../src/db/instrumented-sql-database";
import { SessionInboxStore } from "../../src/db/session-inbox-store";
import { EventRepository } from "../../src/session/event-repository";
import { cleanD1Tables } from "./cleanup";
import { initSession, sqlDatabase } from "./helpers";
import { seedSessionInboxWork } from "../fixtures/session-inbox-work";
import { runInSessionDO } from "./session-do-access";

describe("session query work bounds", () => {
  beforeEach(cleanD1Tables);

  it.each([
    [undefined, false],
    [[], false],
    [["viewer"], true],
    [["viewer", "other"], true],
  ] as const)(
    "only materializes parent links for a nonempty creator filter (%j)",
    async (createdByUserIds, materialized) => {
      const queries: string[] = [];
      const db = sqlDatabase(env.DB);
      const store = new SessionInboxStore({
        prepare(sql) {
          queries.push(sql);
          return db.prepare(sql);
        },
        batch: db.batch.bind(db),
      });
      await store.snapshot({ viewerUserId: "viewer", createdByUserIds, limit: 20 });
      expect(queries[0]).not.toContain("eligible_sessions AS MATERIALIZED (");
      expect(queries[0].includes("eligible_session_links AS MATERIALIZED (")).toBe(materialized);
      queries.length = 0;
      await store.list({
        viewerUserId: "viewer",
        createdByUserIds,
        limit: 20,
        category: "finished",
        cursor: null,
      });
      expect(queries[0]).not.toContain("eligible_sessions AS MATERIALIZED (");
      expect(queries[0].includes("eligible_session_links AS MATERIALIZED (")).toBe(materialized);
    }
  );

  it("seeks deep timeline pages without scanning or sorting the remaining history", async () => {
    const { stub } = await initSession();
    await runInSessionDO(stub, (_instance, state) => {
      state.storage.sql.exec(`WITH RECURSIVE n(x) AS (
        SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000
      ) INSERT INTO events(id,type,data,created_at,timeline_sequence)
        SELECT 'seek-'||x,'token','{}',x/300,x FROM n`);
      let rowsRead = 0;
      const repository = new EventRepository(
        {
          exec(query, ...params) {
            const result = state.storage.sql.exec(query, ...params);
            const rows = result.toArray();
            rowsRead += result.rowsRead;
            return { toArray: () => rows, one: () => rows[0] };
          },
        },
        (fn) => fn()
      );
      const page = repository.getEventTimelinePage({
        cursor: { kind: "timeline", createdAt: 16, sequence: 5000, id: "seek-5000" },
        limit: 50,
      });
      expect(page.events.map((row) => row.id)).toEqual(
        Array.from({ length: 50 }, (_, i) => `seek-${4950 + i}`)
      );
      expect(page.hasMore).toBe(true);
      // An indexed seek visits the requested page, not thousands of older rows.
      expect(rowsRead).toBeLessThan(200);
    });
  });

  it.each(["dense", "sparse"] as const)(
    "keeps %s creator-filtered inbox work bounded",
    async (shape) => {
      const viewer = "query-viewer";
      const count = 4000;
      await seedSessionInboxWork(sqlDatabase(env.DB), count, shape);
      const metrics = createRequestMetrics();
      const store = new SessionInboxStore(instrumentSqlDatabase(env.DB, metrics));
      const options = { viewerUserId: viewer, createdByUserIds: [viewer], limit: 20 };
      const snapshot = await store.snapshot(options);
      expect(snapshot.finished.items).toHaveLength(20);
      expect(snapshot.finished.items[0].rootSession.id).toBe("work-1");
      expect(snapshot.finished.items[0].descendantSessions.map((row) => row.id)).toEqual([
        "work-2",
      ]);
      expect(snapshot.in_progress.items).toEqual([]);
      expect(snapshot.needs_attention.items).toEqual([]);
      expect(metrics.sqlQueries[0].rows_read).toBeGreaterThan(0);
      expect(metrics.sqlQueries[0].rows_read).toBeLessThan(count * 40);
      metrics.sqlQueries.length = 0;
      const page = await store.list({
        ...options,
        category: "finished",
        cursor: snapshot.finished.nextCursor,
      });
      expect(page.items).toHaveLength(20);
      const firstIds = new Set(snapshot.finished.items.map((item) => item.rootSession.id));
      expect(page.items.every((item) => !firstIds.has(item.rootSession.id))).toBe(true);
      expect(metrics.sqlQueries[0].rows_read).toBeGreaterThan(0);
      expect(metrics.sqlQueries[0].rows_read).toBeLessThan(count * 40);
    }
  );
});
