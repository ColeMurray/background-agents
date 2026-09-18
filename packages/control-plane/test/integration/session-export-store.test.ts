import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionExportStore } from "../../src/db/session-export-store";
import { cleanD1Tables } from "./cleanup";
import { sqlDatabase } from "./helpers";

function insertSession(id: string, createdAt: number) {
  return env.DB.prepare("INSERT INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)")
    .bind(id, createdAt, createdAt)
    .run();
}

describe("SessionExportStore integration", () => {
  beforeEach(cleanD1Tables);
  afterEach(cleanD1Tables);

  it("paginates timestamp ties without gaps or newly-created sessions", async () => {
    await insertSession("session-a", 200);
    await insertSession("session-b", 200);
    await insertSession("session-c", 200);
    await insertSession("session-newest", 300);
    const store = new SessionExportStore(sqlDatabase(env.DB));

    const first = await store.list({ cursor: null, limit: 2 });
    expect(first.sessions.map(({ id }) => id)).toEqual(["session-newest", "session-c"]);
    expect(first.nextCursor).toEqual({
      createdAt: 200,
      id: "session-c",
      snapshotMaxRowId: expect.any(Number),
    });

    await insertSession("session-created-during-export", 400);
    await insertSession("session-bb-created-during-export", 200);
    const second = await store.list({ cursor: first.nextCursor, limit: 2 });
    expect(second.sessions.map(({ id }) => id)).toEqual(["session-b", "session-a"]);
    expect(second).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("applies inclusive created-at filters", async () => {
    await insertSession("session-old", 100);
    await insertSession("session-start", 200);
    await insertSession("session-end", 300);
    await insertSession("session-new", 400);

    const result = await new SessionExportStore(sqlDatabase(env.DB)).list({
      cursor: null,
      limit: 10,
      createdAfter: 200,
      createdBefore: 300,
    });

    expect(result.sessions.map(({ id }) => id)).toEqual(["session-end", "session-start"]);
  });
});
