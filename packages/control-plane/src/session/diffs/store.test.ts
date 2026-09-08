import { describe, expect, it } from "vitest";
import type { SqlResult, SqlStorage } from "../sql-storage";
import { DiffFileNotFoundError, DiffRevisionStaleError } from "./errors";
import { SessionDiffStore } from "./store";

class MemoryDiffSql implements SqlStorage {
  row: Record<string, unknown> | null = null;

  exec(query: string, ...params: unknown[]): SqlResult {
    if (query.includes("SELECT * FROM session_diff")) {
      return this.result(this.row ? [this.row] : []);
    }
    if (query.includes("INSERT INTO session_diff") && query.includes("bundle_json")) {
      this.row = {
        singleton: 1,
        revision_id: params[0],
        trigger_message_id: params[1],
        bundle_json: params[2],
        captured_at: params[3],
        last_error: null,
        error_at: null,
        updated_at: params[4],
      };
      return this.result([], 1);
    }
    if (query.includes("INSERT INTO session_diff") && query.includes("last_error")) {
      this.row = {
        revision_id: null,
        trigger_message_id: null,
        bundle_json: null,
        captured_at: null,
        ...this.row,
        last_error: params[0],
        error_at: params[1],
        updated_at: params[2],
      };
      return this.result([], 1);
    }
    return this.result([]);
  }

  private result(rows: unknown[], rowsWritten = 0): SqlResult {
    return {
      toArray: () => rows,
      one: () => rows[0],
      rowsWritten,
    };
  }
}

const upload = {
  version: 1 as const,
  triggerMessageId: "message-1",
  capturedAt: 100,
  repositories: [
    {
      status: "ready" as const,
      position: 0,
      repoOwner: "acme",
      repoName: "web",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      truncated: false,
      omittedFileCount: 0,
      files: [
        {
          id: "file-1",
          path: "src/app.ts",
          status: "modified" as const,
          additions: 1,
          deletions: 1,
          renderState: "renderable" as const,
          patch: "diff --git a/src/app.ts b/src/app.ts\n",
        },
      ],
    },
  ],
};

describe("SessionDiffStore", () => {
  it("returns an empty latest-only state before the first refresh", () => {
    const store = new SessionDiffStore(new MemoryDiffSql());

    expect(store.getPublicState("Changes available after execution")).toEqual({
      version: 1,
      current: null,
      lastError: null,
      unavailableReason: "Changes available after execution",
    });
  });

  it("atomically replaces metadata and patches in one revision", () => {
    const sql = new MemoryDiffSql();
    const store = new SessionDiffStore(sql);

    store.replaceBundle(upload, "revision-1", 200);

    expect(store.getPublicState(null)).toMatchObject({
      current: {
        revisionId: "revision-1",
        capturedAt: 100,
        repositories: [{ files: [{ id: "file-1", path: "src/app.ts" }] }],
      },
      lastError: null,
    });
    expect(JSON.stringify(store.getPublicState(null))).not.toContain("diff --git");
    expect(JSON.parse(String(sql.row?.bundle_json))).not.toHaveProperty("revisionId");
    expect(store.resolveFile("revision-1", "file-1")).toBe(
      "diff --git a/src/app.ts b/src/app.ts\n"
    );
  });

  it("records a bounded failure without replacing the prior bundle", () => {
    const store = new SessionDiffStore(new MemoryDiffSql());
    store.replaceBundle(upload, "revision-1", 200);

    store.recordFailure("collector timed out", 300);

    expect(store.getPublicState(null)).toMatchObject({
      current: { revisionId: "revision-1" },
      lastError: { message: "collector timed out", occurredAt: 300 },
    });
    expect(store.resolveFile("revision-1", "file-1")).toContain("diff --git");
  });

  it("pins selected-file reads to the current revision", () => {
    const store = new SessionDiffStore(new MemoryDiffSql());
    store.replaceBundle(upload, "revision-2", 200);

    let stale: unknown;
    try {
      store.resolveFile("revision-1", "file-1");
    } catch (e) {
      stale = e;
    }
    expect(stale).toBeInstanceOf(DiffRevisionStaleError);
    expect((stale as DiffRevisionStaleError).currentRevisionId).toBe("revision-2");
    expect(() => store.resolveFile("revision-2", "missing-file")).toThrow(DiffFileNotFoundError);
  });

  it("stores a partial multi-repository bundle without mixing prior state", () => {
    const store = new SessionDiffStore(new MemoryDiffSql());
    store.replaceBundle(
      {
        ...upload,
        repositories: [
          upload.repositories[0],
          {
            status: "unavailable",
            position: 1,
            repoOwner: "acme",
            repoName: "api",
            baseSha: "c".repeat(40),
            error: "start commit missing",
            files: [],
          },
        ],
      },
      "revision-partial",
      200
    );

    expect(store.getPublicState(null).current?.repositories).toMatchObject([
      { status: "ready" },
      { status: "unavailable", error: "start commit missing", files: [] },
    ]);
  });

  it("rejects an encoded bundle above the storage limit", () => {
    const store = new SessionDiffStore(new MemoryDiffSql());
    const files = Array.from({ length: 400 }, (_, index) => ({
      id: `file-${index}`,
      path: `${"nested/".repeat(580)}${index}.ts`,
      status: "modified" as const,
      additions: null,
      deletions: null,
      renderState: "metadata_only" as const,
    }));

    expect(() =>
      store.replaceBundle(
        { ...upload, repositories: [{ ...upload.repositories[0], files }] },
        "revision-too-large",
        200
      )
    ).toThrow(/Encoded bundle exceeds/);
  });
});
