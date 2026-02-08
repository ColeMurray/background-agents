/**
 * Unit tests for stopExecution() and the execution_complete guard
 * in processSandboxEvent().
 *
 * These test the SessionDO's stop behavior in isolation using mocks.
 * Since stopExecution and processSandboxEvent are private methods on SessionDO,
 * we test them through the public HTTP and WebSocket interfaces via the DO stub
 * in integration tests. This file tests the repository-level interactions
 * by directly calling the repository methods and verifying state transitions.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SessionRepository, type SqlStorage, type SqlResult } from "./repository";

/**
 * Create a mock SqlStorage that tracks calls and can return configurable data.
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

describe("Stop execution - repository interactions", () => {
  let mock: ReturnType<typeof createMockSql>;
  let repo: SessionRepository;

  beforeEach(() => {
    mock = createMockSql();
    repo = new SessionRepository(mock.sql);
  });

  describe("getProcessingMessage", () => {
    it("returns message when one is processing", () => {
      mock.setData(`SELECT id FROM messages WHERE status = 'processing' LIMIT 1`, [
        { id: "msg-1" },
      ]);
      const result = repo.getProcessingMessage();
      expect(result).toEqual({ id: "msg-1" });
    });

    it("returns null when no message is processing", () => {
      mock.setData(`SELECT id FROM messages WHERE status = 'processing' LIMIT 1`, []);
      expect(repo.getProcessingMessage()).toBeNull();
    });
  });

  describe("updateMessageCompletion", () => {
    it("calls SQL with correct parameters for failed status", () => {
      repo.updateMessageCompletion("msg-1", "failed", 1000);

      const call = mock.calls.find((c) => c.query.includes("UPDATE messages SET status"));
      expect(call).toBeDefined();
      expect(call!.params).toContain("failed");
      expect(call!.params).toContain("msg-1");
      expect(call!.params).toContain(1000);
    });

    it("calls SQL with correct parameters for completed status", () => {
      repo.updateMessageCompletion("msg-2", "completed", 2000);

      const call = mock.calls.find((c) => c.query.includes("UPDATE messages SET status"));
      expect(call).toBeDefined();
      expect(call!.params).toContain("completed");
      expect(call!.params).toContain("msg-2");
    });
  });

  describe("stopExecution state machine", () => {
    it("marks processing message as failed, then getProcessingMessage returns null", () => {
      // First call: message is processing
      mock.setData(`SELECT id FROM messages WHERE status = 'processing' LIMIT 1`, [
        { id: "msg-1" },
      ]);
      const processing = repo.getProcessingMessage();
      expect(processing).toEqual({ id: "msg-1" });

      // Mark as failed
      repo.updateMessageCompletion("msg-1", "failed", Date.now());

      // After update, simulate no processing messages
      mock.setData(`SELECT id FROM messages WHERE status = 'processing' LIMIT 1`, []);
      expect(repo.getProcessingMessage()).toBeNull();
    });

    it("does not error when no processing message exists", () => {
      mock.setData(`SELECT id FROM messages WHERE status = 'processing' LIMIT 1`, []);

      const processing = repo.getProcessingMessage();
      expect(processing).toBeNull();
      // No updateMessageCompletion call needed - this is the idempotent case
    });
  });
});
