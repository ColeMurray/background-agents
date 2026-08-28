import { describe, expect, it, vi } from "vitest";
import { PrAutofixFeedbackStore } from "./pr-autofix-feedback-store";
import type { SqlDatabase, SqlStatement } from "./sql-database";

function createStore() {
  const bind = vi.fn(() => statement);
  const all = vi.fn(async () => ({ results: [], meta: { changes: 0 } }));
  const statement = {
    bind,
    all,
    first: vi.fn(),
    run: vi.fn(),
  } as unknown as SqlStatement;
  const db = { prepare: vi.fn(() => statement) } as unknown as SqlDatabase;

  return { store: new PrAutofixFeedbackStore(db), db, bind, all };
}

function encodeCursor(value: unknown): string {
  return btoa(JSON.stringify(value));
}

describe("PrAutofixFeedbackStore", () => {
  it("parses a valid activity cursor before querying the next page", async () => {
    const { store, bind } = createStore();
    const cursor = encodeCursor({ lastReceivedAt: 2000, feedbackKey: "github:review:1" });

    await expect(store.listActivity({ limit: 10, cursor })).resolves.toEqual({
      records: [],
      nextCursor: null,
    });

    expect(bind).toHaveBeenCalledWith(2000, 2000, "github:review:1", 11);
  });

  it("rejects malformed activity cursor JSON before querying", async () => {
    const { store, db } = createStore();
    const cursor = encodeCursor({ lastReceivedAt: 2000 });

    await expect(store.listActivity({ limit: 10, cursor })).rejects.toThrow(
      "Invalid Autofix activity cursor"
    );
    expect(db.prepare).not.toHaveBeenCalled();
  });
});
