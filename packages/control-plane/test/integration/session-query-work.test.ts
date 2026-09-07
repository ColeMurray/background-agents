import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createRequestMetrics,
  instrumentSqlDatabase,
} from "../../src/db/instrumented-sql-database";
import { SessionInboxStore } from "../../src/db/session-inbox-store";
import { EventRepository } from "../../src/session/event-repository";
import { cleanD1Tables } from "./cleanup";
import { initSession, seedActiveUser, sqlDatabase } from "./helpers";
import { runInSessionDO } from "./session-do-access";

describe("session query work bounds", () => {
  beforeEach(cleanD1Tables);

  it.each([
    [undefined, false],
    [[], false],
    [["viewer"], true],
    [["viewer", "other"], true],
  ] as const)(
    "only materializes eligible sessions for a nonempty creator filter (%j)",
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
      expect(queries[0].includes("eligible_sessions AS MATERIALIZED (")).toBe(materialized);
      queries.length = 0;
      await store.list({
        viewerUserId: "viewer",
        createdByUserIds,
        limit: 20,
        category: "finished",
        cursor: null,
      });
      expect(queries[0].includes("eligible_sessions AS MATERIALIZED (")).toBe(materialized);
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

  it("keeps creator-filtered inbox work linear when hidden parents split lineages", async () => {
    const viewer = "query-viewer";
    const other = "query-other";
    await seedActiveUser(viewer);
    await seedActiveUser(other);
    const count = 4000;
    await env.DB.prepare(
      `WITH RECURSIVE n(x) AS (
      SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?
    ) INSERT INTO sessions(id,title,repo_owner,repo_name,model,status,user_id,
        parent_session_id,root_session_id,spawn_source,spawn_depth,created_at,updated_at)
      SELECT 'work-'||x,'Session','acme','lab','model','completed',
        CASE WHEN x%3=0 THEN ? ELSE ? END,
        CASE WHEN x%10=2 THEN 'work-'||(x-1) ELSE NULL END,
        'work-'||(CASE WHEN x%10=2 THEN x-1 ELSE x END),
        CASE WHEN x%10=2 THEN 'agent' ELSE 'user' END,
        CASE WHEN x%10=2 THEN 1 ELSE 0 END,1000,100000-x
      FROM n`
    )
      .bind(count, other, viewer)
      .run();
    const metrics = createRequestMetrics();
    const store = new SessionInboxStore(instrumentSqlDatabase(env.DB, metrics));
    const options = { viewerUserId: viewer, createdByUserIds: [viewer], limit: 20 };
    const snapshot = await store.snapshot(options);
    expect(snapshot.finished.items).toHaveLength(20);
    expect(snapshot.finished.items[0].rootSession.id).toBe("work-1");
    expect(snapshot.finished.items[0].descendantSessions.map((row) => row.id)).toEqual(["work-2"]);
    expect(snapshot.in_progress.items).toEqual([]);
    expect(snapshot.needs_attention.items).toEqual([]);
    expect(metrics.sqlQueries[0].rows_read).toBeGreaterThan(0);
    expect(metrics.sqlQueries[0].rows_read).toBeLessThan(count * 40);
    const page = await store.list({
      ...options,
      category: "finished",
      cursor: snapshot.finished.nextCursor,
    });
    expect(page.items).toHaveLength(20);
    const firstIds = new Set(snapshot.finished.items.map((item) => item.rootSession.id));
    expect(page.items.every((item) => !firstIds.has(item.rootSession.id))).toBe(true);
  });
});
