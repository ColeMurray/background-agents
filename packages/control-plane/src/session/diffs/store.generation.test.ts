import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createNodeSqlStorage } from "../../node/sqlite-storage";
import type { SessionDiffUpload } from "@open-inspect/shared/types/session-diffs";
import { SessionDiffStore } from "./store";

function bundle(path: string, publicationGeneration?: number): SessionDiffUpload {
  return {
    version: 1,
    ...(publicationGeneration === undefined ? {} : { publicationGeneration }),
    triggerMessageId: path,
    capturedAt: publicationGeneration ?? 0,
    repositories: [
      {
        status: "ready",
        position: 0,
        repoOwner: "acme",
        repoName: "widgets",
        baseSha: "a".repeat(40),
        headSha: "a".repeat(40),
        truncated: false,
        omittedFileCount: 0,
        files: [],
      },
    ],
  };
}

describe("SessionDiffStore Pi publication generation fence", () => {
  it("acknowledges delayed stale/equal generations without replacing the visible latest bundle", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`CREATE TABLE session_diff (
      singleton INTEGER PRIMARY KEY, revision_id TEXT, trigger_message_id TEXT,
      bundle_json TEXT, captured_at INTEGER, pi_publication_generation INTEGER,
      last_error TEXT, error_at INTEGER, updated_at INTEGER NOT NULL
    )`);
    const store = new SessionDiffStore(createNodeSqlStorage(database).sql);

    expect(store.replaceBundle(bundle("b", 2), "revision-b", 2)).toBe("revision-b");
    expect(store.replaceBundle(bundle("a", 1), "revision-a", 3)).toBe("revision-b");
    expect(store.replaceBundle(bundle("b-retry", 2), "revision-b-retry", 4)).toBe("revision-b");
    expect(store.getPublicState(null).current).toMatchObject({
      revisionId: "revision-b",
      triggerMessageId: "b",
    });
    database.close();
  });

  it("accepts a generated Pi bundle over a legacy row with no generation", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`CREATE TABLE session_diff (
      singleton INTEGER PRIMARY KEY, revision_id TEXT, trigger_message_id TEXT,
      bundle_json TEXT, captured_at INTEGER, pi_publication_generation INTEGER,
      last_error TEXT, error_at INTEGER, updated_at INTEGER NOT NULL
    )`);
    const store = new SessionDiffStore(createNodeSqlStorage(database).sql);
    store.replaceBundle(bundle("legacy"), "legacy", 1);
    expect(store.replaceBundle(bundle("pi", 1), "pi-1", 2)).toBe("pi-1");
    database.close();
  });
});
