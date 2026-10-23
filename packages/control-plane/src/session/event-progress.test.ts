import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { EventRepository } from "./event-repository";
import { applyMigrations, initSchema, MIGRATIONS } from "./schema";

it.each(["token", "tool_call"] as const)(
  "uses durable update time for repeated %s identities",
  (type) => {
    const db = new DatabaseSync(":memory:");
    try {
      const { sql, transactionSync } = createNodeSqlStorage(db);
      initSchema(sql);
      const events = new EventRepository(sql, transactionSync);
      const now = 2_000_000;
      const write = (at: number) => {
        if (type === "token")
          events.upsertTokenEvent(
            "task",
            {
              type: "token",
              content: "working",
              partId: "same-part",
              messageId: "task",
              sandboxId: "sandbox",
              timestamp: at / 1000,
            },
            at
          );
        else
          events.upsertToolCallEvent(
            "task",
            {
              type: "tool_call",
              tool: "exec",
              callId: "same-call",
              args: {},
              messageId: "task",
              sandboxId: "sandbox",
              timestamp: at / 1000,
            },
            at
          );
      };
      write(now - 700_000);
      expect(events.hasRecentExecutionProgress("task", now - 600_000, now)).toBe(false);
      write(now);
      const restarted = new EventRepository(sql, transactionSync);
      expect(restarted.hasRecentExecutionProgress("task", now - 600_000, now)).toBe(true);
      expect(restarted.hasRecentExecutionProgress("other-task", now - 600_000, now)).toBe(false);
      expect(restarted.hasRecentExecutionProgress("task", now + 1, now + 100)).toBe(false);
      expect(db.prepare("SELECT created_at FROM events").all()).toEqual([
        { created_at: now - 700_000 },
      ]);
    } finally {
      db.close();
    }
  }
);

it("migrates old event rows without losing their original progress timestamp", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE events (id TEXT PRIMARY KEY, type TEXT, data TEXT, message_id TEXT, created_at INTEGER)"
    );
    db.exec("INSERT INTO events VALUES ('legacy', 'token', '{}', 'task', 1000)");
    db.exec(
      "CREATE TABLE _schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)"
    );
    for (const migration of MIGRATIONS.filter(({ id }) => id !== 57))
      db.prepare("INSERT INTO _schema_migrations VALUES (?, 0)").run(migration.id);
    const { sql, transactionSync } = createNodeSqlStorage(db);
    applyMigrations(sql);
    expect(db.prepare("SELECT updated_at FROM events").get()).toEqual({ updated_at: null });
    expect(
      new EventRepository(sql, transactionSync).hasRecentExecutionProgress("task", 999, 1001)
    ).toBe(true);
    applyMigrations(sql);
  } finally {
    db.close();
  }
});
