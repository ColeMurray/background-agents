/**
 * Unit tests for SessionCoreRepository.
 *
 * Uses a mock SqlStorage to verify SQL operations are called correctly.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SessionCoreRepository } from "./session-core-repository";
import type { SqlResult, SqlStorage } from "./sql-storage";

/**
 * Create a mock SqlStorage that tracks calls and returns configurable data.
 */
function createMockSql() {
  const calls: Array<{ query: string; params: unknown[] }> = [];
  const mockData: Map<string, unknown[]> = new Map();
  const rowsWrittenByQuery: Map<string, number> = new Map();
  let defaultRowsWritten = 0;
  let oneValue: unknown = null;

  const sql: SqlStorage = {
    exec(query: string, ...params: unknown[]): SqlResult {
      calls.push({ query, params });
      const data = mockData.get(query) ?? [];
      let consumed = false;
      return {
        toArray: () => {
          consumed = true;
          return data;
        },
        one: () => {
          consumed = true;
          return oneValue;
        },
        get rowsWritten() {
          return consumed ? (rowsWrittenByQuery.get(query) ?? defaultRowsWritten) : 0;
        },
      };
    },
  };

  return {
    sql,
    calls,
    setData(query: string, data: unknown[]) {
      mockData.set(query, data);
    },
    setRowsWritten(query: string, rowsWritten: number) {
      rowsWrittenByQuery.set(query, rowsWritten);
    },
    setDefaultRowsWritten(rowsWritten: number) {
      defaultRowsWritten = rowsWritten;
    },
    setOne(value: unknown) {
      oneValue = value;
    },
    reset() {
      calls.length = 0;
      mockData.clear();
      rowsWrittenByQuery.clear();
      defaultRowsWritten = 0;
      oneValue = null;
    },
  };
}

describe("SessionCoreRepository", () => {
  let mock: ReturnType<typeof createMockSql>;
  let repo: SessionCoreRepository;

  beforeEach(() => {
    mock = createMockSql();
    repo = new SessionCoreRepository(mock.sql, (closure) => closure());
  });

  // === SESSION ===

  describe("getSession", () => {
    it("returns null when no session exists", () => {
      mock.setData(`SELECT * FROM session LIMIT 1`, []);
      expect(repo.getSession()).toBeNull();
    });

    it("returns session when it exists", () => {
      const session = {
        id: "sess-1",
        session_name: "test-session",
        title: "Test",
        repo_owner: "owner",
        repo_name: "repo",
        repo_id: null,
      };
      mock.setData(`SELECT * FROM session LIMIT 1`, [session]);
      expect(repo.getSession()).toEqual(session);
    });
  });

  describe("upsertSession", () => {
    it("executes correct SQL with all parameters", () => {
      repo.upsertSession({
        id: "sess-1",
        sessionName: "test-session",
        title: "Test Title",
        repoOwner: "owner",
        repoName: "repo",
        model: "claude-sonnet-4",
        status: "created",
        createdAt: 1000,
        updatedAt: 2000,
      });

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("INSERT OR REPLACE INTO session");
      expect(mock.calls[0].params).toEqual([
        "sess-1",
        "test-session",
        "Test Title",
        "owner",
        "repo",
        null,
        "main",
        "claude-sonnet-4",
        null,
        "created",
        null,
        "user",
        0,
        0,
        0,
        null,
        null,
        1000,
        2000,
      ]);
    });

    it("rejects partial repository context", () => {
      expect(() =>
        repo.upsertSession({
          id: "sess-1",
          sessionName: "test-session",
          title: "Test Title",
          repoOwner: "owner",
          repoName: null,
          model: "claude-sonnet-4",
          status: "created",
          createdAt: 1000,
          updatedAt: 2000,
        })
      ).toThrow("Session repository context must include repoOwner and repoName together");
    });

    it("rejects repo metadata for no-repository sessions", () => {
      expect(() =>
        repo.upsertSession({
          id: "sess-1",
          sessionName: "test-session",
          title: "Test Title",
          repoOwner: null,
          repoName: null,
          repoId: 123,
          baseBranch: "main",
          model: "claude-sonnet-4",
          status: "created",
          createdAt: 1000,
          updatedAt: 2000,
        })
      ).toThrow("No-repository sessions must not persist repoId or baseBranch");
    });
  });

  describe("updateSessionRepoId", () => {
    it("updates repo_id", () => {
      repo.updateSessionRepoId(12345);

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE session SET repo_id");
      expect(mock.calls[0].params).toEqual([12345]);
    });
  });

  describe("updateSessionBranch", () => {
    it("updates branch for correct session", () => {
      repo.updateSessionBranch("sess-1", "feature-branch");

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE session SET branch_name");
      expect(mock.calls[0].params).toEqual(["feature-branch", "sess-1"]);
    });
  });

  describe("updateSessionCurrentSha", () => {
    it("updates SHA", () => {
      repo.updateSessionCurrentSha("abc123");

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE session SET current_sha");
      expect(mock.calls[0].params).toEqual(["abc123"]);
    });
  });

  describe("updateSessionStatus", () => {
    it("updates status and timestamp", () => {
      repo.updateSessionStatus("sess-1", "active", 3000);

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE session SET status");
      expect(mock.calls[0].params).toEqual(["active", 3000, "sess-1"]);
    });
  });

  describe("updateSessionTitleIfUnset", () => {
    it("updates the title only when the current title is unset", () => {
      mock.setData(`SELECT * FROM session LIMIT 1`, [{ id: "sess-1", title: null }]);
      mock.setRowsWritten(
        `UPDATE session SET title = ?, updated_at = ?
       WHERE id = ? AND (title IS NULL OR TRIM(title) = '')`,
        1
      );

      expect(repo.updateSessionTitleIfUnset("sess-1", "Generated title", 4000)).toBe(true);
      expect(mock.calls[0].query).toContain("WHERE id = ? AND (title IS NULL OR TRIM(title) = '')");
      expect(mock.calls[0].params).toEqual(["Generated title", 4000, "sess-1"]);
    });

    it("returns false when a title already exists", () => {
      mock.setData(`SELECT * FROM session LIMIT 1`, [{ id: "sess-1", title: "Manual title" }]);
      mock.setRowsWritten(
        `UPDATE session SET title = ?, updated_at = ?
       WHERE id = ? AND (title IS NULL OR TRIM(title) = '')`,
        0
      );

      expect(repo.updateSessionTitleIfUnset("sess-1", "Generated title", 4000)).toBe(false);
    });
  });

  describe("addSessionCost", () => {
    it("increments total_cost and updates updated_at for the current session", () => {
      repo.addSessionCost(0.0123, 5000);

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("SET total_cost = total_cost + ?");
      expect(mock.calls[0].query).toContain("updated_at = ?");
      expect(mock.calls[0].params).toEqual([0.0123, 5000]);
    });
  });

  // === SESSION REPOSITORIES ===

  describe("replaceSessionRepositories", () => {
    it("deletes existing rows before inserting the new set in order", () => {
      repo.replaceSessionRepositories([
        { position: 0, repoOwner: "acme", repoName: "frontend", repoId: 1, baseBranch: "main" },
        {
          position: 1,
          repoOwner: "acme",
          repoName: "backend",
          repoId: null,
          baseBranch: "develop",
        },
      ]);

      expect(mock.calls.length).toBe(3);
      expect(mock.calls[0].query).toContain("DELETE FROM session_repositories");
      expect(mock.calls[1].query).toContain("INSERT INTO session_repositories");
      expect(mock.calls[1].params).toEqual([0, "acme", "frontend", 1, "main"]);
      expect(mock.calls[2].params).toEqual([1, "acme", "backend", null, "develop"]);
    });

    it("clears all rows when given an empty set", () => {
      repo.replaceSessionRepositories([]);

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("DELETE FROM session_repositories");
    });
  });

  describe("getSessionRepositoryRows", () => {
    it("returns rows ordered by position", () => {
      const rows = [
        { position: 0, repo_owner: "acme", repo_name: "frontend" },
        { position: 1, repo_owner: "acme", repo_name: "backend" },
      ];
      mock.setData(`SELECT * FROM session_repositories ORDER BY position`, rows);

      expect(repo.getSessionRepositoryRows()).toEqual(rows);
    });

    it("returns an empty list for pre-feature sessions", () => {
      expect(repo.getSessionRepositoryRows()).toEqual([]);
    });
  });

  describe("setSessionDiffBaselines", () => {
    it("writes each baseline once using position and repository identity", () => {
      repo.setSessionDiffBaselines([
        {
          position: 0,
          repoOwner: "acme",
          repoName: "web",
          baseSha: "a".repeat(40),
          isPrimary: true,
        },
        {
          position: 1,
          repoOwner: "acme",
          repoName: "web",
          baseSha: "b".repeat(40),
          isPrimary: false,
        },
      ]);

      expect(mock.calls[0].query).toContain("WHERE position = ?");
      expect(mock.calls[0].query).toContain("repo_owner = ?");
      expect(mock.calls[0].query).toContain("repo_name = ?");
      expect(mock.calls[0].query).toContain("base_sha IS NULL");
      expect(mock.calls[0].params).toEqual(["a".repeat(40), 0, "acme", "web"]);
      expect(mock.calls[1].query).toContain("UPDATE session SET base_sha");
      expect(mock.calls[1].query).toContain("base_sha IS NULL");
      expect(mock.calls[1].params).toEqual(["a".repeat(40), "acme", "web"]);
      expect(mock.calls[2].query).toContain("WHERE position = ?");
      expect(mock.calls[2].params).toEqual(["b".repeat(40), 1, "acme", "web"]);
    });

    it("applies all baseline updates in one transaction", () => {
      let transactions = 0;
      repo = new SessionCoreRepository(mock.sql, (closure) => {
        transactions += 1;
        return closure();
      });

      repo.setSessionDiffBaselines([
        {
          position: 0,
          repoOwner: "acme",
          repoName: "web",
          baseSha: "a".repeat(40),
          isPrimary: true,
        },
        {
          position: 1,
          repoOwner: "acme",
          repoName: "api",
          baseSha: "b".repeat(40),
          isPrimary: false,
        },
      ]);

      expect(transactions).toBe(1);
      expect(mock.calls).toHaveLength(3);
    });
  });
});
