import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createNodeSqlDatabase } from "../node/sqlite-database";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { initSchema } from "./schema";
import { SessionCoreRepository } from "./session-core-repository";
import { SessionIndexStore } from "../db/session-index";
import { SessionStatusProjectionStore } from "../db/session-status-projection-store";
import { SessionStatusService } from "./session-status-service";

it("a delayed archive projection cannot overwrite a successful equal-timestamp unarchive", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = createNodeSqlDatabase(sqlite);
  const clock = vi.spyOn(Date, "now").mockReturnValue(5000);
  try {
    await db
      .prepare(
        "CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT, updated_at INTEGER, status_revision INTEGER NOT NULL DEFAULT 0)"
      )
      .run();
    await db.prepare("INSERT INTO sessions VALUES ('one', 'completed', 5000, 0)").run();
    const storage = createNodeSqlStorage(sqlite);
    initSchema(storage.sql);
    storage.sql.exec(
      "INSERT INTO session (id, status, created_at, updated_at) VALUES ('one', 'archived', 1000, 2000)"
    );
    const repository = new SessionCoreRepository(storage.sql, storage.transactionSync);
    const store = new SessionIndexStore(db);
    const realProjection = new SessionStatusProjectionStore(db);
    const projectionResult = vi.spyOn(realProjection, "project");
    let release!: () => void;
    let projectionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      projectionStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new SessionStatusService(
      { submit: () => {} } as never,
      { error: () => {} } as never,
      repository,
      { getMessageCount: () => 0, getActiveDurationMs: () => 0 } as never,
      { listArtifacts: () => [] } as never,
      { broadcast: () => {} } as never,
      store,
      {
        project: async (id, status, revision, updatedAt) => {
          if (status === "archived") {
            projectionStarted();
            await gate;
          }
          return realProjection.project(id, status, revision, updatedAt);
        },
      },
      { fetch: async () => new Response() }
    );
    const confirmation = service.confirmIndexStatus("archived").catch((error) => error);
    await started;
    // D1 dispatch can await here; unlike Node's SQLite adapter, the write has
    // not yet committed. The newer transition genuinely projects successfully.
    expect(await service.transition("completed")).toBe(true);
    expect(await projectionResult.mock.results[0].value).toBe(true);
    release();
    expect(await confirmation).toEqual(new Error("Status superseded"));
    expect(repository.getSession()).toMatchObject({ status: "completed", status_revision: 2 });
    expect(
      await db
        .prepare("SELECT status, updated_at, status_revision FROM sessions WHERE id = 'one'")
        .first()
    ).toEqual({ status: "completed", updated_at: 5000, status_revision: 2 });
  } finally {
    clock.mockRestore();
    db.close();
  }
});
