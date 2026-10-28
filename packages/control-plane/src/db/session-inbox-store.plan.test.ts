import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { SessionInboxStore, type InboxFilterOptions } from "./session-inbox-store";
import type { SqlDatabase } from "./sql-database";

const VIEWER_ID = "inbox-viewer";
let db: NodeSqlDatabase;

beforeEach(() => {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(
    sqlite,
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
  );
  db = createNodeSqlDatabase(sqlite);
});

afterEach(() => db.close());

describe("SessionInboxStore query plan", () => {
  it("materializes recursive queries but leaves unscoped bulk marking flattenable", async () => {
    await db
      .prepare("INSERT INTO users (id, created_at, updated_at) VALUES (?, 1, 1)")
      .bind(VIEWER_ID)
      .run();

    const sessions: Array<{
      id: string;
      parentId?: string;
      rootId?: string;
      status?: string;
      updatedAt: number;
      unread?: boolean;
    }> = [
      { id: "archived-root", status: "archived", updatedAt: 1 },
      ...Array.from({ length: 2000 }, (_, i) => ({
        id: `history-${i}`,
        ...(i < 200 ? { parentId: "archived-root", rootId: "archived-root" } : {}),
        updatedAt: 1,
      })),
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `history-grandchild-${i}`,
        parentId: `history-${i}`,
        rootId: "archived-root",
        updatedAt: 1,
      })),
      {
        id: "attention-root",
        parentId: "archived-root",
        rootId: "archived-root",
        updatedAt: 10000,
      },
      {
        id: "unread-child",
        parentId: "attention-root",
        rootId: "archived-root",
        updatedAt: 10030,
        unread: true,
      },
      { id: "active-root", updatedAt: 10010 },
      {
        id: "active-child",
        parentId: "active-root",
        rootId: "active-root",
        status: "active",
        updatedAt: 10020,
      },
      { id: "finished-root", updatedAt: 10015 },
    ];
    await db
      .prepare(
        `INSERT INTO sessions
           (id, user_id, status, created_at, updated_at, parent_session_id, root_session_id,
            latest_terminal_message_id, latest_terminal_message_created_at,
            latest_terminal_message_completed_at)
         VALUES ${sessions.map(() => "(?, ?, ?, 1, ?, ?, ?, ?, ?, ?)").join(", ")}`
      )
      .bind(
        ...sessions.flatMap((session) => [
          session.id,
          VIEWER_ID,
          session.status ?? "completed",
          session.updatedAt,
          session.parentId ?? null,
          session.rootId ?? session.id,
          session.unread ? "terminal-message" : null,
          session.unread ? session.updatedAt : null,
          session.unread ? session.updatedAt : null,
        ])
      )
      .run();

    const captured: Array<{ sql: string; values: unknown[] }> = [];
    const measured: SqlDatabase = {
      prepare(sql) {
        const statement = db.prepare(sql);
        return {
          ...statement,
          bind(...values) {
            captured.push({ sql, values });
            return statement.bind(...values);
          },
        };
      },
      batch: (statements) => db.batch(statements),
    };
    const options: InboxFilterOptions = {
      viewerUserId: VIEWER_ID,
      createdByUserIds: [VIEWER_ID],
      scope: "all",
      readScope: {
        kind: "user",
        userId: VIEWER_ID,
        roleKey: "member",
        permissions: ["sessions.read"],
        suspended: false,
        memberships: new Map(),
      },
      mode: "on",
    };
    const inbox = new SessionInboxStore(measured);
    const snapshot = await inbox.snapshot({ ...options, limit: 1 });

    expect(snapshot).toMatchObject({
      needs_attention: {
        items: [
          {
            rootSession: { id: "attention-root" },
            descendantSessions: [{ id: "unread-child", readState: { unread: true } }],
          },
        ],
        hasMore: false,
        nextCursor: null,
      },
      in_progress: {
        items: [
          { rootSession: { id: "active-root" }, descendantSessions: [{ id: "active-child" }] },
        ],
        hasMore: false,
        nextCursor: null,
      },
      finished: {
        items: [{ rootSession: { id: "finished-root" }, descendantSessions: [] }],
        hasMore: true,
        nextCursor: { latestUpdatedAt: 10015, rootSessionId: "finished-root" },
      },
    });

    const query = captured[0];
    const plan = await db
      .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
      .bind(...query.values)
      .all<{ id: number; parent: number; detail: string }>();
    expect(
      plan.results.some(({ detail }) => detail.includes("MATERIALIZE eligible_sessions"))
    ).toBe(true);
    const recursiveSteps = plan.results.filter(({ detail }) => detail === "RECURSIVE STEP");
    expect(recursiveSteps).toHaveLength(1);
    const recursiveDetails = plan.results
      .filter(({ parent }) => parent === recursiveSteps[0].id)
      .map(({ detail }) => detail);
    expect(recursiveDetails.length).toBeGreaterThan(0);
    expect(recursiveDetails.some((detail) => /^(SEARCH|SCAN) sessions\b/.test(detail))).toBe(false);

    for (const rootSessionId of [undefined, "attention-root"]) {
      captured.length = 0;
      const markedCount = await inbox.markAllRead(options, rootSessionId);
      expect(markedCount).toBe(rootSessionId === undefined ? 1 : 0);
      const markQuery = captured[0];
      const markPlan = await db
        .prepare(`EXPLAIN QUERY PLAN ${markQuery.sql}`)
        .bind(...markQuery.values)
        .all<{ detail: string }>();
      expect(
        markPlan.results.some(({ detail }) => detail.includes("MATERIALIZE eligible_sessions"))
      ).toBe(rootSessionId !== undefined);
      if (rootSessionId === undefined) {
        expect(
          markPlan.results.some(({ detail }) => /^SCAN eligible_sessions\b/.test(detail))
        ).toBe(false);
      }
    }
    const readStates = await db
      .prepare("SELECT session_id, last_read_message_id FROM session_read_states WHERE user_id = ?")
      .bind(VIEWER_ID)
      .all();
    expect(readStates.results).toEqual([
      { session_id: "unread-child", last_read_message_id: "terminal-message" },
    ]);
  });
});
