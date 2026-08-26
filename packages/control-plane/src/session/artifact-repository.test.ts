import { beforeEach, describe, expect, it } from "vitest";
import { ArtifactRepository } from "./artifact-repository";
import type { SqlResult, SqlStorage } from "./sql-storage";

function createMockSql() {
  const calls: Array<{ query: string; params: unknown[] }> = [];
  const rowsByQuery = new Map<string, unknown[]>();
  const sql: SqlStorage = {
    exec(query: string, ...params: unknown[]): SqlResult {
      calls.push({ query, params });
      return {
        toArray: () => rowsByQuery.get(query) ?? [],
        one: () => null,
        rowsWritten: 0,
      };
    },
  };
  return {
    sql,
    calls,
    setRows(query: string, rows: unknown[]) {
      rowsByQuery.set(query, rows);
    },
  };
}

describe("ArtifactRepository", () => {
  let mock: ReturnType<typeof createMockSql>;
  let repository: ArtifactRepository;

  beforeEach(() => {
    mock = createMockSql();
    repository = new ArtifactRepository(mock.sql);
  });

  it("stores artifact with updated_at starting at created_at", () => {
    repository.createArtifact({
      id: "art-1",
      type: "pr",
      url: "https://github.com/owner/repo/pull/1",
      metadata: '{"number":1}',
      createdAt: 1000,
    });

    expect(mock.calls[0].query).toContain("INSERT INTO artifacts");
    expect(mock.calls[0].query).toContain("updated_at");
    expect(mock.calls[0].params).toEqual([
      "art-1",
      "pr",
      "https://github.com/owner/repo/pull/1",
      '{"number":1}',
      1000,
      1000,
    ]);
  });

  it("updates url, metadata, and updated_at in place", () => {
    repository.updateArtifact("art-1", {
      url: "https://github.com/owner/renamed/pull/1",
      metadata: '{"number":1}',
      updatedAt: 3000,
    });

    expect(mock.calls[0].query).toContain(
      "UPDATE artifacts SET url = ?, metadata = ?, updated_at = ? WHERE id = ?"
    );
    expect(mock.calls[0].params).toEqual([
      "https://github.com/owner/renamed/pull/1",
      '{"number":1}',
      3000,
      "art-1",
    ]);
  });

  it("lists artifacts in descending creation order", () => {
    repository.listArtifacts();
    expect(mock.calls[0].query).toContain("ORDER BY created_at DESC");
  });

  it("returns an empty artifact list when none exist", () => {
    mock.setRows(`SELECT * FROM artifacts ORDER BY created_at DESC`, []);
    expect(repository.listArtifacts()).toEqual([]);
  });

  it("queries artifacts by id", () => {
    repository.getArtifactById("art-1");
    expect(mock.calls[0].query).toContain("SELECT * FROM artifacts WHERE id = ?");
    expect(mock.calls[0].params).toEqual(["art-1"]);
  });

  it("returns null when the artifact is missing", () => {
    expect(repository.getArtifactById("missing")).toBeNull();
  });
});
