/**
 * Unit tests for SessionRepository.
 *
 * Uses a mock SqlStorage to verify SQL operations are called correctly.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { SessionRepository } from "./repository";
import { EventRepository } from "./event-repository";
import {
  AttachmentClaimConflictError,
  SessionAttachmentRepository,
} from "./session-attachment-repository";
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

describe("SessionRepository", () => {
  let mock: ReturnType<typeof createMockSql>;
  let repo: SessionRepository;
  let transactionSyncCalls: number;

  beforeEach(() => {
    mock = createMockSql();
    transactionSyncCalls = 0;
    repo = new SessionRepository(
      mock.sql,
      (closure) => {
        transactionSyncCalls += 1;
        return closure();
      },
      new SessionAttachmentRepository(mock.sql),
      new EventRepository(mock.sql, (closure) => closure())
    );
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
      repo = new SessionRepository(
        mock.sql,
        (closure) => {
          transactions += 1;
          return closure();
        },
        new SessionAttachmentRepository(mock.sql),
        new EventRepository(mock.sql, (closure) => closure())
      );

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

  // === SANDBOX ===

  describe("getSandbox", () => {
    it("returns null when no sandbox exists", () => {
      mock.setData(`SELECT * FROM sandbox LIMIT 1`, []);
      expect(repo.getSandbox()).toBeNull();
    });

    it("returns sandbox when it exists", () => {
      const sandbox = { id: "sb-1", status: "ready" };
      mock.setData(`SELECT * FROM sandbox LIMIT 1`, [sandbox]);
      expect(repo.getSandbox()).toEqual(sandbox);
    });
  });

  describe("createSandbox", () => {
    it("creates sandbox with correct parameters", () => {
      repo.createSandbox({
        id: "sb-1",
        status: "pending",
        gitSyncStatus: "pending",
        createdAt: 1000,
      });

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("INSERT INTO sandbox");
      expect(mock.calls[0].params).toEqual(["sb-1", "pending", "pending", 1000]);
    });
  });

  describe("updateSandboxStatus", () => {
    it("updates status", () => {
      repo.updateSandboxStatus("ready");

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET status");
      expect(mock.calls[0].params).toEqual(["ready"]);
    });
  });

  describe("updateSandboxForSpawn", () => {
    it("sets all spawn fields atomically", () => {
      repo.updateSandboxForSpawn({
        status: "spawning",
        createdAt: 1000,
        authTokenHash: "token-hash-123",
        modalSandboxId: "modal-sb-1",
      });

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET");
      expect(mock.calls[0].query).toContain("status");
      expect(mock.calls[0].query).toContain("auth_token_hash");
      expect(mock.calls[0].query).toContain("modal_sandbox_id");
      expect(mock.calls[0].query).toContain("auth_token = NULL");
      expect(mock.calls[0].query).toContain("modal_object_id = NULL");
      expect(mock.calls[0].query).toContain("vnc_url = NULL");
      expect(mock.calls[0].query).toContain("vnc_password = NULL");
      expect(mock.calls[0].params).toEqual(["spawning", 1000, "token-hash-123", "modal-sb-1"]);
    });
  });

  describe("updateSandboxModalObjectId", () => {
    it("updates modal object ID", () => {
      repo.updateSandboxModalObjectId("obj-123");

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET modal_object_id");
      expect(mock.calls[0].params).toEqual(["obj-123"]);
    });
  });

  describe("updateSandboxSnapshotImageId", () => {
    it("updates snapshot image ID for specific sandbox", () => {
      repo.updateSandboxSnapshotImageId("sb-1", "img-123");

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET snapshot_image_id");
      expect(mock.calls[0].params).toEqual(["img-123", "sb-1"]);
    });
  });

  describe("updateSandboxHeartbeat", () => {
    it("updates heartbeat timestamp", () => {
      repo.updateSandboxHeartbeat(5000);

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET last_heartbeat");
      expect(mock.calls[0].params).toEqual([5000]);
    });
  });

  describe("updateSandboxLastActivity", () => {
    it("updates activity timestamp", () => {
      repo.updateSandboxLastActivity(6000);

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET last_activity");
      expect(mock.calls[0].params).toEqual([6000]);
    });
  });

  describe("updateSandboxGitSyncStatus", () => {
    it("updates git sync status", () => {
      repo.updateSandboxGitSyncStatus("completed");

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET git_sync_status");
      expect(mock.calls[0].params).toEqual(["completed"]);
    });
  });

  describe("updateSandboxSpawnError", () => {
    it("updates spawn error fields", () => {
      repo.updateSandboxSpawnError("Failed to spawn sandbox", 123456);

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET last_spawn_error");
      expect(mock.calls[0].params).toEqual(["Failed to spawn sandbox", 123456]);
    });
  });

  describe("VNC access", () => {
    it("stores and clears VNC credentials", () => {
      repo.updateSandboxVnc("https://vnc.test", "encrypted-password");
      repo.clearSandboxVnc();

      expect(mock.calls[0].query).toContain("SET vnc_url = ?, vnc_password = ?");
      expect(mock.calls[0].params).toEqual(["https://vnc.test", "encrypted-password"]);
      expect(mock.calls[1].query).toContain("SET vnc_url = NULL, vnc_password = NULL");
    });

    it("can clear only the VNC URL", () => {
      repo.clearSandboxVncUrl();

      expect(mock.calls[0].query).toContain("SET vnc_url = NULL");
      expect(mock.calls[0].query).not.toContain("vnc_password");
    });
  });

  describe("resetCircuitBreaker", () => {
    it("resets failure count to zero", () => {
      repo.resetCircuitBreaker();

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("spawn_failure_count = 0");
    });
  });

  describe("incrementCircuitBreakerFailure", () => {
    it("increments count and sets timestamp", () => {
      repo.incrementCircuitBreakerFailure(7000);

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("spawn_failure_count = COALESCE");
      expect(mock.calls[0].query).toContain("last_spawn_failure");
      expect(mock.calls[0].params).toEqual([7000]);
    });
  });

  // === MESSAGES ===

  describe("getMessageCount", () => {
    it("returns 0 when empty", () => {
      mock.setOne({ count: 0 });
      expect(repo.getMessageCount()).toBe(0);
    });

    it("returns correct count", () => {
      mock.setOne({ count: 5 });
      expect(repo.getMessageCount()).toBe(5);
    });
  });

  describe("getPendingOrProcessingCount", () => {
    it("counts pending and processing messages", () => {
      mock.setOne({ count: 3 });
      expect(repo.getPendingOrProcessingCount()).toBe(3);
      expect(mock.calls[0].query).toContain("'pending', 'processing'");
    });
  });

  describe("getProcessingMessage", () => {
    it("returns null when none processing", () => {
      mock.setData(`SELECT id FROM messages WHERE status = 'processing' LIMIT 1`, []);
      expect(repo.getProcessingMessage()).toBeNull();
    });

    it("returns processing message", () => {
      mock.setData(`SELECT id FROM messages WHERE status = 'processing' LIMIT 1`, [
        { id: "msg-1" },
      ]);
      expect(repo.getProcessingMessage()).toEqual({ id: "msg-1" });
    });
  });

  describe("getNextPendingMessage", () => {
    it("returns oldest pending message", () => {
      const message = { id: "msg-1", created_at: 1000 };
      // The query is dynamic, so we match by result
      mock.setData(
        `SELECT * FROM messages WHERE status = 'pending' ORDER BY created_at ASC, rowid ASC LIMIT 1`,
        [message]
      );
      expect(repo.getNextPendingMessage()).toEqual(message);
      expect(mock.calls[0].query).toContain("ORDER BY created_at ASC, rowid ASC");
    });
  });

  describe("prompt queue", () => {
    it("returns null instead of position zero for a finished idempotent message", () => {
      mock.setData(
        `SELECT id FROM messages WHERE status IN ('pending', 'processing')
       ORDER BY CASE status WHEN 'processing' THEN 0 ELSE 1 END, created_at ASC, rowid ASC`,
        [{ id: "msg-other" }]
      );
      expect(repo.getUnfinishedMessagePosition("msg-complete")).toBeNull();
    });

    it("projects only fields needed to render the queue", () => {
      vi.spyOn(repo, "listUnfinishedMessages").mockReturnValue([
        {
          id: "msg-legacy",
          author_id: "part-1",
          content: "continue",
          source: "web",
          model: null,
          reasoning_effort: null,
          attachments: "{bad json",
          callback_context: null,
          client_request_id: null,
          request_fingerprint: null,
          status: "pending",
          error_message: null,
          stop_confirmation_deadline: null,
          created_at: 1000,
          started_at: null,
          completed_at: null,
        },
      ]);

      expect(repo.listPromptQueue()).toEqual([
        { messageId: "msg-legacy", content: "continue", status: "pending" },
      ]);
    });
  });

  describe("createMessage", () => {
    it("creates message with all fields", () => {
      repo.createMessage({
        id: "msg-1",
        authorId: "p-1",
        content: "Hello",
        source: "web",
        model: "claude-sonnet-4",
        attachments: "[]",
        callbackContext: '{"channel":"C123"}',
        status: "pending",
        createdAt: 1000,
      });

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("INSERT INTO messages");
      expect(mock.calls[0].params).toEqual([
        "msg-1",
        "p-1",
        "Hello",
        "web",
        "claude-sonnet-4",
        null,
        "[]",
        '{"channel":"C123"}',
        null,
        null,
        "pending",
        1000,
      ]);
    });
  });

  describe("createMessageWithAttachments", () => {
    const message = {
      id: "msg-1",
      authorId: "p-1",
      content: "Look",
      source: "web" as const,
      status: "pending" as const,
      createdAt: 1000,
    };

    it("claims uploads and creates the pending message in one transaction", () => {
      let transactions = 0;
      repo = new SessionRepository(
        mock.sql,
        (closure) => {
          transactions += 1;
          return closure();
        },
        new SessionAttachmentRepository(mock.sql),
        new EventRepository(mock.sql, (closure) => closure())
      );
      mock.setDefaultRowsWritten(2);

      repo.createMessageWithAttachments(message, ["up-1", "up-2"]);

      expect(transactions).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE attachments SET message_id");
      expect(mock.calls[0].params).toEqual(["msg-1", "up-1", "up-2"]);
      expect(mock.calls[1].query).toContain("INSERT INTO messages");
      expect(mock.calls).toHaveLength(2);
    });

    it("fails before creating the message when not every upload can be claimed", () => {
      mock.setDefaultRowsWritten(1);

      expect(() => repo.createMessageWithAttachments(message, ["up-1", "up-2"])).toThrow(
        AttachmentClaimConflictError
      );
      expect(mock.calls).toHaveLength(1);
    });
  });

  describe("cancelPendingMessage", () => {
    const statusQuery = `SELECT status, source, callback_context FROM messages WHERE id = ?`;

    it("atomically releases attachments and deletes a pending message", () => {
      mock.setData(statusQuery, [{ status: "pending", source: "web", callback_context: null }]);
      mock.setDefaultRowsWritten(1);

      expect(repo.cancelPendingMessage("msg-1")).toBe(true);

      expect(transactionSyncCalls).toBe(1);
      expect(mock.calls[1]).toMatchObject({
        query: expect.stringContaining("UPDATE attachments SET message_id = NULL"),
        params: ["msg-1"],
      });
      expect(mock.calls[2]).toMatchObject({
        query: expect.stringContaining("DELETE FROM messages"),
        params: ["msg-1"],
      });
    });

    it("does not change a processing message", () => {
      mock.setData(statusQuery, [{ status: "processing", source: "web", callback_context: null }]);

      expect(repo.cancelPendingMessage("msg-1")).toBe(false);
      expect(mock.calls).toHaveLength(1);
    });

    it("does not delete a non-web prompt that may require a callback", () => {
      mock.setData(statusQuery, [{ status: "pending", source: "linear", callback_context: null }]);

      expect(repo.cancelPendingMessage("msg-1")).toBe(false);
      expect(mock.calls).toHaveLength(1);
    });

    it("does not delete a prompt with a completion callback", () => {
      mock.setData(statusQuery, [
        { status: "pending", source: "web", callback_context: '{"channel":"C1"}' },
      ]);

      expect(repo.cancelPendingMessage("msg-1")).toBe(false);
      expect(mock.calls).toHaveLength(1);
    });
  });

  describe("startMessageProcessing", () => {
    it("updates processing state and materializes the user event in one transaction", () => {
      repo.startMessageProcessing("msg-1", 2000, {
        type: "user_message",
        content: "Hello",
        messageId: "msg-1",
        timestamp: 2,
        author: { participantId: "p-1", userId: "u-1", name: "User" },
      });

      expect(transactionSyncCalls).toBe(1);
      expect(mock.calls[0].query).toContain("status = 'processing'");
      expect(mock.calls[0].params).toEqual([2000, "msg-1"]);
      expect(mock.calls[1].query).toContain("INSERT INTO events");
      expect(mock.calls[1].params.at(-1)).toBe(2000);
    });

    it("appends the canonical event without updating legacy timeline rows", () => {
      repo.startMessageProcessing("msg-1", 2000, {
        type: "user_message",
        content: "Hello",
        messageId: "msg-1",
        timestamp: 2,
        author: { participantId: "p-1", userId: "u-1", name: "User" },
      });

      expect(mock.calls).toHaveLength(2);
      expect(mock.calls[1].query).toContain("INSERT INTO events");
      expect(mock.calls[1].query).not.toContain("UPDATE events");
      expect(mock.calls[1].params[0]).toBe("user_message:msg-1");
    });
  });

  describe("recordMessageCompletion", () => {
    const messageQuery = `SELECT status, created_at, started_at FROM messages WHERE id = ?`;

    it("atomically records message state and its canonical completion event", () => {
      mock.setData(messageQuery, [{ status: "processing", created_at: 1000, started_at: 1200 }]);
      const event = {
        type: "execution_complete" as const,
        messageId: "msg-1",
        success: true,
        sandboxId: "sb-1",
        timestamp: 3,
      };

      expect(repo.recordMessageCompletion(event, 3000, "processing")).toEqual({
        messageId: "msg-1",
        messageCreatedAt: 1000,
        messageStartedAt: 1200,
        completedAt: 3000,
        status: "completed",
      });

      expect(transactionSyncCalls).toBe(1);
      expect(mock.calls[1].params).toEqual(["completed", 3000, null, "msg-1"]);
      expect(mock.calls[2].params).toEqual([
        "execution_complete:msg-1",
        "execution_complete",
        JSON.stringify(event),
        "msg-1",
        3000,
      ]);
    });

    it("persists a failed outcome and error", () => {
      mock.setData(messageQuery, [{ status: "processing", created_at: 1000, started_at: 1200 }]);
      const event = {
        type: "execution_complete" as const,
        messageId: "msg-1",
        success: false,
        error: "Agent failed",
        sandboxId: "sb-1",
        timestamp: 3,
      };

      const completion = repo.recordMessageCompletion(event, 3000, "processing");

      expect(completion?.status).toBe("failed");
      expect(mock.calls[1].params).toEqual(["failed", 3000, "Agent failed", "msg-1"]);
    });

    it("does not record an outcome for a message in another state", () => {
      mock.setData(messageQuery, [{ status: "completed", created_at: 1000, started_at: 1200 }]);

      const completion = repo.recordMessageCompletion(
        {
          type: "execution_complete",
          messageId: "msg-1",
          success: true,
          sandboxId: "sb-1",
          timestamp: 3,
        },
        3000,
        "processing"
      );

      expect(completion).toBeNull();
      expect(mock.calls).toHaveLength(1);
    });
  });

  describe("stop confirmation deadline", () => {
    it("marks, reads, and clears the dedicated deadline without changing error_message", () => {
      const query = `SELECT id, stop_confirmation_deadline FROM messages
       WHERE stop_confirmation_deadline IS NOT NULL LIMIT 1`;
      mock.setData(query, [{ id: "msg-1", stop_confirmation_deadline: 5000 }]);

      repo.markMessageAwaitingStopConfirmation("msg-1", 5000);
      expect(mock.calls[0].query).toContain("SET stop_confirmation_deadline = ?");
      expect(mock.calls[0].query).not.toContain("error_message");
      expect(repo.getMessageAwaitingStopConfirmation()).toEqual({ id: "msg-1", deadline: 5000 });
      repo.clearMessageAwaitingStopConfirmation("msg-1");
      expect(mock.calls[2].query).toContain("SET stop_confirmation_deadline = NULL");
      expect(mock.calls[2].query).not.toContain("error_message");
    });
  });

  describe("listPendingMessagesWithCreatedAt", () => {
    it("returns pending messages in deterministic queue order", () => {
      mock.setData(
        `SELECT id, created_at FROM messages WHERE status = 'pending' ORDER BY created_at ASC, rowid ASC`,
        [{ id: "msg-1", created_at: 1000 }]
      );

      expect(repo.listPendingMessagesWithCreatedAt()).toEqual([{ id: "msg-1", created_at: 1000 }]);

      expect(mock.calls[0].query).toContain("SELECT id, created_at FROM messages");
      expect(mock.calls[0].query).toContain("WHERE status = 'pending'");
      expect(mock.calls[0].query).toContain("ORDER BY created_at ASC, rowid ASC");
      expect(mock.calls[0].params).toEqual([]);
    });
  });

  describe("getNextPendingMessage", () => {
    it("uses rowid as the stable tie-breaker for equal timestamps", () => {
      repo.getNextPendingMessage();

      expect(mock.calls[0].query).toContain("ORDER BY created_at ASC, rowid ASC");
    });
  });

  describe("listMessages", () => {
    it("returns messages with pagination", () => {
      repo.listMessages({ limit: 10 });
      expect(mock.calls[0].query).toContain("ORDER BY created_at DESC");
      expect(mock.calls[0].query).toContain("LIMIT ?");
    });

    it("filters by status when provided", () => {
      repo.listMessages({ limit: 10, status: "pending" });
      expect(mock.calls[0].query).toContain("status = ?");
      expect(mock.calls[0].params).toContain("pending");
    });

    it("uses cursor for pagination", () => {
      repo.listMessages({ limit: 10, cursor: "5000" });
      expect(mock.calls[0].query).toContain("created_at < ?");
      expect(mock.calls[0].params).toContain(5000);
    });
  });

  describe("getLatestTerminalMessage", () => {
    it("selects the newest completed or failed message", () => {
      repo.getLatestTerminalMessage();

      expect(mock.calls[0].query).toContain("status IN ('completed', 'failed')");
      expect(mock.calls[0].query).toContain(
        "ORDER BY COALESCE(completed_at, started_at, created_at) DESC"
      );
      expect(mock.calls[0].query).toContain("LIMIT 1");
    });
  });

  // === PR HELPERS ===

  describe("getProcessingMessageAuthor", () => {
    it("returns null when no processing message", () => {
      mock.setData(`SELECT author_id FROM messages WHERE status = 'processing' LIMIT 1`, []);
      expect(repo.getProcessingMessageAuthor()).toBeNull();
    });

    it("returns author_id of processing message", () => {
      mock.setData(`SELECT author_id FROM messages WHERE status = 'processing' LIMIT 1`, [
        { author_id: "p-1" },
      ]);
      expect(repo.getProcessingMessageAuthor()).toEqual({ author_id: "p-1" });
    });
  });

  describe("getMessageCallbackContext", () => {
    it("returns null for unknown message", () => {
      mock.setData(`SELECT callback_context, source FROM messages WHERE id = ?`, []);
      expect(repo.getMessageCallbackContext("unknown")).toBeNull();
    });

    it("returns callback context", () => {
      mock.setData(`SELECT callback_context, source FROM messages WHERE id = ?`, [
        { callback_context: '{"channel":"C123"}', source: "slack" },
      ]);
      expect(repo.getMessageCallbackContext("msg-1")).toEqual({
        callback_context: '{"channel":"C123"}',
        source: "slack",
      });
    });
  });
});
