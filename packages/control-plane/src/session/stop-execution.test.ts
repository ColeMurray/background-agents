/**
 * Unit tests for the stop-execution–related repository behavior.
 *
 * These tests exercise MessageRepository processing-message lookup used by
 * stopExecution() and the execution_complete guard in processSandboxEvent().
 *
 * We focus here on the repository-level interactions and state transitions
 * by directly calling the repository methods and verifying their effects.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MessageRepository } from "./message-repository";
import { EventRepository } from "./event-repository";
import { SessionAttachmentRepository } from "./session-attachment-repository";
import type { SqlResult, SqlStorage } from "./sql-storage";

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
  let repo: MessageRepository;

  beforeEach(() => {
    mock = createMockSql();
    repo = new MessageRepository(
      mock.sql,
      (closure) => closure(),
      new SessionAttachmentRepository(mock.sql),
      new EventRepository(mock.sql, (closure) => closure())
    );
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
});
