/**
 * Unit tests for SessionRepository.
 *
 * Uses a mock SqlStorage to verify SQL operations are called correctly.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SessionRepository, type SqlStorage, type SqlResult } from "./repository";

/**
 * Create a mock SqlStorage that tracks calls and returns configurable data.
 */
function createMockSql() {
  const calls: Array<{ query: string; params: unknown[] }> = [];
  const mockData: Map<string, unknown[]> = new Map();
  let oneValue: unknown = null;

  const sql: SqlStorage = {
    exec(query: string, ...params: unknown[]): SqlResult {
      calls.push({ query, params });
      const data = mockData.get(query) ?? [];
      return {
        toArray: () => data,
        one: () => oneValue,
      };
    },
  };

  return {
    sql,
    calls,
    setData(query: string, data: unknown[]) {
      mockData.set(query, data);
    },
    setOne(value: unknown) {
      oneValue = value;
    },
    reset() {
      calls.length = 0;
      mockData.clear();
      oneValue = null;
    },
  };
}

describe("SessionRepository", () => {
  let mock: ReturnType<typeof createMockSql>;
  let repo: SessionRepository;

  beforeEach(() => {
    mock = createMockSql();
    repo = new SessionRepository(mock.sql);
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
        1000,
        2000,
      ]);
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

  // === PARTICIPANTS ===

  describe("getParticipantByUserId", () => {
    it("returns null for unknown user", () => {
      mock.setData(`SELECT * FROM participants WHERE user_id = ?`, []);
      expect(repo.getParticipantByUserId("unknown")).toBeNull();
    });

    it("returns participant when found", () => {
      const participant = { id: "p-1", user_id: "user-1" };
      mock.setData(`SELECT * FROM participants WHERE user_id = ?`, [participant]);
      expect(repo.getParticipantByUserId("user-1")).toEqual(participant);
    });
  });

  describe("getParticipantByWsTokenHash", () => {
    it("returns null for unknown token", () => {
      mock.setData(`SELECT * FROM participants WHERE ws_auth_token = ?`, []);
      expect(repo.getParticipantByWsTokenHash("unknown-hash")).toBeNull();
    });

    it("finds participant by token hash", () => {
      const participant = { id: "p-1", ws_auth_token: "hash-123" };
      mock.setData(`SELECT * FROM participants WHERE ws_auth_token = ?`, [participant]);
      expect(repo.getParticipantByWsTokenHash("hash-123")).toEqual(participant);
    });
  });

  describe("getParticipantById", () => {
    it("returns participant by ID", () => {
      const participant = { id: "p-1", user_id: "user-1" };
      mock.setData(`SELECT * FROM participants WHERE id = ?`, [participant]);
      expect(repo.getParticipantById("p-1")).toEqual(participant);
    });
  });

  describe("createParticipant", () => {
    it("creates participant with all fields", () => {
      repo.createParticipant({
        id: "p-1",
        userId: "user-1",
        scmUserId: "gh-123",
        scmLogin: "testuser",
        scmName: "Test User",
        scmEmail: "test@example.com",
        scmAccessTokenEncrypted: "encrypted-token",
        scmTokenExpiresAt: 9000,
        role: "owner",
        joinedAt: 1000,
      });

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("INSERT INTO participants");
      expect(mock.calls[0].params).toEqual([
        "p-1",
        "user-1",
        "gh-123",
        "testuser",
        "Test User",
        "test@example.com",
        "encrypted-token",
        null,
        9000,
        "owner",
        1000,
      ]);
    });

    it("handles null optional fields", () => {
      repo.createParticipant({
        id: "p-1",
        userId: "user-1",
        role: "member",
        joinedAt: 1000,
      });

      expect(mock.calls[0].params).toEqual([
        "p-1",
        "user-1",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        "member",
        1000,
      ]);
    });
  });

  describe("updateParticipantCoalesce", () => {
    it("only updates non-null fields", () => {
      repo.updateParticipantCoalesce("p-1", {
        scmLogin: "newlogin",
        scmName: null,
      });

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("COALESCE");
      expect(mock.calls[0].params[0]).toBe(null); // scmUserId
      expect(mock.calls[0].params[1]).toBe("newlogin");
      expect(mock.calls[0].params[7]).toBe("p-1"); // participantId
    });
  });

  describe("updateParticipantWsToken", () => {
    it("sets token hash and timestamp", () => {
      repo.updateParticipantWsToken("p-1", "new-hash", 8000);

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("ws_auth_token");
      expect(mock.calls[0].query).toContain("ws_token_created_at");
      expect(mock.calls[0].params).toEqual(["new-hash", 8000, "p-1"]);
    });
  });

  describe("listParticipants", () => {
    it("returns ordered by join time", () => {
      const participants = [
        { id: "p-1", joined_at: 1000 },
        { id: "p-2", joined_at: 2000 },
      ];
      mock.setData(`SELECT * FROM participants ORDER BY joined_at`, participants);

      expect(repo.listParticipants()).toEqual(participants);
      expect(mock.calls[0].query).toContain("ORDER BY joined_at");
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
        `SELECT * FROM messages WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`,
        [message]
      );
      expect(repo.getNextPendingMessage()).toEqual(message);
      expect(mock.calls[0].query).toContain("ORDER BY created_at ASC");
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
        "pending",
        1000,
      ]);
    });
  });

  describe("updateMessageToProcessing", () => {
    it("changes status and sets startedAt", () => {
      repo.updateMessageToProcessing("msg-1", 2000);

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("status = 'processing'");
      expect(mock.calls[0].query).toContain("started_at");
      expect(mock.calls[0].params).toEqual([2000, "msg-1"]);
    });
  });

  describe("updateMessageCompletion", () => {
    it("sets status and completedAt", () => {
      repo.updateMessageCompletion("msg-1", "completed", 3000);

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("status = ?");
      expect(mock.calls[0].query).toContain("completed_at");
      expect(mock.calls[0].params).toEqual(["completed", 3000, "msg-1"]);
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

  // === EVENTS ===

  describe("createEvent", () => {
    it("stores event with all fields", () => {
      repo.createEvent({
        id: "evt-1",
        type: "tool_call",
        data: '{"tool":"read"}',
        messageId: "msg-1",
        createdAt: 1000,
      });

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("INSERT INTO events");
      expect(mock.calls[0].params).toEqual([
        "evt-1",
        "tool_call",
        '{"tool":"read"}',
        "msg-1",
        1000,
      ]);
    });
  });

  describe("upsertTokenEvent", () => {
    it("upserts token event by deterministic message key", () => {
      const event = {
        type: "token" as const,
        content: "partial response",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1,
      };

      repo.upsertTokenEvent("msg-1", event, 1000);

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("INSERT INTO events");
      expect(mock.calls[0].query).toContain("VALUES (?, ?, ?, ?, ?)");
      expect(mock.calls[0].query).toContain("ON CONFLICT(id) DO UPDATE SET");
      expect(mock.calls[0].params).toEqual([
        "token:msg-1",
        "token",
        JSON.stringify(event),
        "msg-1",
        1000,
      ]);
    });

    it("reuses the same deterministic ID across updates", () => {
      const firstEvent = {
        type: "token" as const,
        content: "first",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1,
      };
      const secondEvent = {
        ...firstEvent,
        content: "second",
        timestamp: 2,
      };

      repo.upsertTokenEvent("msg-1", firstEvent, 1000);
      repo.upsertTokenEvent("msg-1", secondEvent, 2000);

      expect(mock.calls.length).toBe(2);
      expect(mock.calls[0].params[0]).toBe("token:msg-1");
      expect(mock.calls[1].params[0]).toBe("token:msg-1");
      expect(mock.calls[1].params[1]).toBe("token");
      expect(mock.calls[1].params[2]).toBe(JSON.stringify(secondEvent));
      expect(mock.calls[1].params[4]).toBe(2000);
    });
  });

  describe("upsertExecutionCompleteEvent", () => {
    it("upserts completion event by deterministic message key", () => {
      const event = {
        type: "execution_complete" as const,
        messageId: "msg-1",
        success: true,
        sandboxId: "sb-1",
        timestamp: 2,
      };

      repo.upsertExecutionCompleteEvent("msg-1", event, 2000);

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("INSERT INTO events");
      expect(mock.calls[0].query).toContain("VALUES (?, ?, ?, ?, ?)");
      expect(mock.calls[0].query).toContain("ON CONFLICT(id) DO UPDATE SET");
      expect(mock.calls[0].params).toEqual([
        "execution_complete:msg-1",
        "execution_complete",
        JSON.stringify(event),
        "msg-1",
        2000,
      ]);
    });

    it("reuses the same deterministic completion ID across updates", () => {
      const firstEvent = {
        type: "execution_complete" as const,
        messageId: "msg-1",
        success: false,
        sandboxId: "sb-1",
        timestamp: 2,
      };
      const secondEvent = {
        ...firstEvent,
        success: true,
        timestamp: 3,
      };

      repo.upsertExecutionCompleteEvent("msg-1", firstEvent, 2000);
      repo.upsertExecutionCompleteEvent("msg-1", secondEvent, 3000);

      expect(mock.calls.length).toBe(2);
      expect(mock.calls[0].params[0]).toBe("execution_complete:msg-1");
      expect(mock.calls[1].params[0]).toBe("execution_complete:msg-1");
      expect(mock.calls[1].params[1]).toBe("execution_complete");
      expect(mock.calls[1].params[2]).toBe(JSON.stringify(secondEvent));
      expect(mock.calls[1].params[4]).toBe(3000);
    });
  });

  describe("listEvents", () => {
    it("returns in descending order", () => {
      repo.listEvents({ limit: 50 });
      expect(mock.calls[0].query).toContain("ORDER BY created_at DESC");
    });

    it("filters by type", () => {
      repo.listEvents({ limit: 50, type: "tool_call" });
      expect(mock.calls[0].query).toContain("type = ?");
      expect(mock.calls[0].params).toContain("tool_call");
    });

    it("filters by messageId", () => {
      repo.listEvents({ limit: 50, messageId: "msg-1" });
      expect(mock.calls[0].query).toContain("message_id = ?");
      expect(mock.calls[0].params).toContain("msg-1");
    });

    it("uses cursor for pagination", () => {
      repo.listEvents({ limit: 50, cursor: "5000" });
      expect(mock.calls[0].query).toContain("created_at < ?");
      expect(mock.calls[0].params).toContain(5000);
    });
  });

  describe("getEventsForReplay", () => {
    it("returns newest events in ascending order via DESC subquery", () => {
      repo.getEventsForReplay(500);

      expect(mock.calls.length).toBe(1);
      // Inner subquery selects newest events via DESC
      expect(mock.calls[0].query).toContain("ORDER BY created_at DESC, id DESC LIMIT ?");
      // Outer query re-sorts to chronological ASC for replay
      expect(mock.calls[0].query).toContain("ORDER BY created_at ASC, id ASC");
      expect(mock.calls[0].params).toEqual([500]);
    });
  });

  describe("getEventsHistoryPage", () => {
    it("queries events with composite cursor excluding heartbeats", () => {
      repo.getEventsHistoryPage(5000, "cursor-id", 50);

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("FROM events");
      expect(mock.calls[0].query).toContain("type != 'heartbeat'");
      expect(mock.calls[0].query).toContain("created_at < ?1");
      expect(mock.calls[0].query).toContain("created_at = ?1 AND id < ?2");
      expect(mock.calls[0].query).toContain("ORDER BY created_at DESC, id DESC");
      expect(mock.calls[0].params).toEqual([5000, "cursor-id", 51]); // limit + 1
    });

    it("returns hasMore=false when results fit within limit", () => {
      const query = `SELECT * FROM events
         WHERE type != 'heartbeat' AND ((created_at < ?1) OR (created_at = ?1 AND id < ?2))
         ORDER BY created_at DESC, id DESC LIMIT ?3`;

      mock.setData(query, [
        { id: "e1", created_at: 4000, type: "token", data: "{}" },
        { id: "e2", created_at: 3000, type: "tool_call", data: "{}" },
      ]);

      const result = repo.getEventsHistoryPage(5000, "cursor-id", 50);
      expect(result.hasMore).toBe(false);
      expect(result.events.length).toBe(2);
    });

    it("returns hasMore=true and trims overflow when results exceed limit", () => {
      const query = `SELECT * FROM events
         WHERE type != 'heartbeat' AND ((created_at < ?1) OR (created_at = ?1 AND id < ?2))
         ORDER BY created_at DESC, id DESC LIMIT ?3`;

      // 3 rows returned, limit = 2 → hasMore = true, last row trimmed
      mock.setData(query, [
        { id: "e1", created_at: 4000, type: "token", data: "{}" },
        { id: "e2", created_at: 3000, type: "tool_call", data: "{}" },
        { id: "e3", created_at: 2000, type: "token", data: "{}" },
      ]);

      const result = repo.getEventsHistoryPage(5000, "cursor-id", 2);
      expect(result.hasMore).toBe(true);
      expect(result.events.length).toBe(2);
    });

    it("returns events in chronological order (reversed from DESC query)", () => {
      const query = `SELECT * FROM events
         WHERE type != 'heartbeat' AND ((created_at < ?1) OR (created_at = ?1 AND id < ?2))
         ORDER BY created_at DESC, id DESC LIMIT ?3`;

      mock.setData(query, [
        { id: "e2", created_at: 4000, type: "token", data: "{}" },
        { id: "e1", created_at: 3000, type: "tool_call", data: "{}" },
      ]);

      const result = repo.getEventsHistoryPage(5000, "cursor-id", 50);
      // After reverse(), oldest first
      expect(result.events[0].id).toBe("e1");
      expect(result.events[1].id).toBe("e2");
    });

    it("returns empty results with hasMore=false when no data matches cursor", () => {
      const result = repo.getEventsHistoryPage(5000, "cursor-id", 50);
      expect(result.events).toEqual([]);
      expect(result.hasMore).toBe(false);
    });
  });

  // === ARTIFACTS ===

  describe("createArtifact", () => {
    it("stores artifact", () => {
      repo.createArtifact({
        id: "art-1",
        type: "pr",
        url: "https://github.com/owner/repo/pull/1",
        metadata: '{"number":1}',
        createdAt: 1000,
      });

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("INSERT INTO artifacts");
      expect(mock.calls[0].params).toEqual([
        "art-1",
        "pr",
        "https://github.com/owner/repo/pull/1",
        '{"number":1}',
        1000,
      ]);
    });
  });

  describe("listArtifacts", () => {
    it("returns in descending order", () => {
      repo.listArtifacts();
      expect(mock.calls[0].query).toContain("ORDER BY created_at DESC");
    });

    it("returns empty array when none", () => {
      mock.setData(`SELECT * FROM artifacts ORDER BY created_at DESC`, []);
      expect(repo.listArtifacts()).toEqual([]);
    });
  });

  // === WS CLIENT MAPPING ===

  describe("upsertWsClientMapping", () => {
    it("creates mapping", () => {
      repo.upsertWsClientMapping({
        wsId: "ws-1",
        participantId: "p-1",
        clientId: "client-1",
        createdAt: 1000,
      });

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("INSERT OR REPLACE INTO ws_client_mapping");
      expect(mock.calls[0].params).toEqual(["ws-1", "p-1", "client-1", 1000]);
    });
  });

  describe("getWsClientMapping", () => {
    it("returns null for unknown ws", () => {
      // Query has JOIN, use generic matching
      expect(repo.getWsClientMapping("unknown")).toBeNull();
    });

    it("returns mapping with joined participant data", () => {
      // The actual query contains JOIN, so set data for that specific query pattern
      repo.getWsClientMapping("ws-1");
      expect(mock.calls[0].query).toContain("JOIN participants");
      expect(mock.calls[0].query).toContain("ws_client_mapping");
    });
  });

  describe("hasWsClientMapping", () => {
    it("returns false for unknown ws", () => {
      mock.setData(`SELECT participant_id FROM ws_client_mapping WHERE ws_id = ?`, []);
      expect(repo.hasWsClientMapping("unknown")).toBe(false);
    });

    it("returns true when mapping exists", () => {
      mock.setData(`SELECT participant_id FROM ws_client_mapping WHERE ws_id = ?`, [
        { participant_id: "p-1" },
      ]);
      expect(repo.hasWsClientMapping("ws-1")).toBe(true);
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
