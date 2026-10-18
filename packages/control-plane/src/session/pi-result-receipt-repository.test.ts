import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { PiResultReceiptRepository } from "./pi-result-receipt-repository";
import { initSchema } from "./schema";

describe("PiResultReceiptRepository", () => {
  it("keeps a bounded terminal tombstone window", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const storage = createNodeSqlStorage(database);
      initSchema(storage.sql);
      const receipts = new PiResultReceiptRepository(storage.sql);
      for (let index = 0; index < 130; index++) receipts.record(`operation-${index}`, index);

      expect(database.prepare("SELECT COUNT(*) AS count FROM pi_result_receipts").get()).toEqual({
        count: 128,
      });
      expect(receipts.has("operation-0")).toBe(false);
      expect(receipts.has("operation-129")).toBe(true);
    } finally {
      database.close();
    }
  });
});
