import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { initSchema } from "./schema";
import { PiControlRepository } from "./pi-control-repository";
const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));
function repository() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const storage = createNodeSqlStorage(database);
  initSchema(storage.sql);
  return new PiControlRepository(storage.sql);
}
describe("PiControlRepository", () => {
  it("admits a stable request once and replays its bounded result", () => {
    const receipts = repository();
    const input = {
      requestId: "request-1",
      requestHash: "a".repeat(64),
      action: "follow_up",
      actorId: "user-1",
      source: "web",
    };
    expect(receipts.admit(input, 1).created).toBe(true);
    expect(receipts.admit(input, 2).created).toBe(false);
    expect(
      receipts.settle("request-1", "completed", { submissionId: 4 }, undefined, 3)?.result
    ).toEqual({ submissionId: 4 });
  });
  it("authorizes only live model-running controls", () => {
    const receipts = repository();
    receipts.admit(
      {
        requestId: "operation-1",
        requestHash: "a".repeat(64),
        action: "submit",
        actorId: "user-1",
        source: "web",
      },
      1
    );
    receipts.settle("operation-1", "accepted", { submissionId: 1 }, undefined, 2);
    expect(receipts.isActiveOperation("operation-1")).toBe(true);
    expect(receipts.complete("operation-1", "completed", undefined, 3).changed).toBe(true);
    expect(receipts.isActiveOperation("operation-1")).toBe(false);
    expect(receipts.complete("operation-1", "completed", undefined, 4).changed).toBe(false);
  });
  it("rejects request-id drift and prunes old terminal receipts", () => {
    const receipts = repository();
    receipts.admit(
      {
        requestId: "same",
        requestHash: "a".repeat(64),
        action: "reset",
        actorId: "u1",
        source: "web",
      },
      1
    );
    expect(() =>
      receipts.admit(
        {
          requestId: "same",
          requestHash: "b".repeat(64),
          action: "reset",
          actorId: "u1",
          source: "web",
        },
        2
      )
    ).toThrow(/conflict/);
    receipts.settle("same", "completed", undefined, undefined, 3);
    receipts.prune(0);
    expect(receipts.get("same")).toBeNull();
  });
});
