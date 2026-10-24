import { DatabaseSync } from "node:sqlite";
import { NodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { beforeEach, describe, expect, it } from "vitest";
import { durableTurnActionCeiling, PiTurnAuthorityStore } from "./turn-authority";

let store: PiTurnAuthorityStore;

beforeEach(async () => {
  const database = new NodeSqliteDatabase(new DatabaseSync(":memory:"));
  await database.exec(`CREATE TABLE oi_pi_turn_authority (
    operation_id TEXT PRIMARY KEY,
    deadline_ms INTEGER,
    remaining_actions INTEGER NOT NULL CHECK (remaining_actions >= 0),
    created_at INTEGER NOT NULL
  )`);
  store = new PiTurnAuthorityStore(database);
});

describe("PiTurnAuthorityStore", () => {
  it("restores the original deadline and consumed action count", async () => {
    const original = await store.initialize("message-1", 10_000, 2);
    const ceiling = durableTurnActionCeiling(store, original);
    await expect(ceiling.consume()).resolves.toBe(true);

    const restored = await store.get("message-1");

    expect(restored).toEqual({
      operationId: "message-1",
      deadlineMs: 10_000,
      remainingActions: 1,
    });
    const recoveredCeiling = durableTurnActionCeiling(store, restored!);
    await expect(recoveredCeiling.consume()).resolves.toBe(true);
    await expect(recoveredCeiling.consume()).resolves.toBe(false);

    // A retry cannot extend the original turn deadline or refill its ceiling.
    await expect(store.initialize("message-1", 20_000, 512)).resolves.toEqual({
      operationId: "message-1",
      deadlineMs: 10_000,
      remainingActions: 0,
    });
  });

  it("atomically refuses parallel actions beyond the durable ceiling", async () => {
    const authority = await store.initialize("message-2", undefined, 2);
    const ceiling = durableTurnActionCeiling(store, authority);

    const consumed = await Promise.all([ceiling.consume(), ceiling.consume(), ceiling.consume()]);

    expect(consumed.filter(Boolean)).toHaveLength(2);
    await expect(store.get("message-2")).resolves.toMatchObject({ remainingActions: 0 });
  });
});
