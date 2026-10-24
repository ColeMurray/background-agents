import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { initSchema } from "./schema";
import { PiOperationRepository } from "./pi-operation-repository";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function repository(): PiOperationRepository {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const storage = createNodeSqlStorage(database);
  initSchema(storage.sql);
  return new PiOperationRepository(storage.sql);
}

describe("PiOperationRepository", () => {
  it("uses expected-state transitions so a stale submit cannot regress stopping", () => {
    const operations = repository();
    expect(operations.begin("operation-1", 1)).toBe(true);
    expect(operations.transition("operation-1", ["dispatching"], "stopping", 2)).toBe(true);

    expect(operations.transition("operation-1", ["dispatching"], "admitted", 3)).toBe(false);
    expect(operations.get("operation-1")).toEqual({
      operationId: "operation-1",
      state: "stopping",
      lastProjectionSequence: 0,
    });
  });

  it("advances projection acknowledgement only from the exact prior sequence", () => {
    const operations = repository();
    operations.begin("operation-1", 1);

    expect(operations.advanceProjection("operation-1", 0, 1, 2)).toBe(true);
    expect(operations.advanceProjection("operation-1", 0, 2, 3)).toBe(false);
    expect(operations.advanceProjection("operation-1", 1, 2, 4)).toBe(true);
    expect(operations.get("operation-1")?.lastProjectionSequence).toBe(2);
  });

  it("bounds settled operation tombstones", () => {
    const operations = repository();
    for (let index = 0; index < 130; index++) {
      const operationId = `operation-${index}`;
      operations.begin(operationId, index);
      operations.settle(operationId, ["dispatching"], index);
    }

    expect(operations.get("operation-0")).toBeNull();
    expect(operations.get("operation-129")?.state).toBe("settled");
  });
});
